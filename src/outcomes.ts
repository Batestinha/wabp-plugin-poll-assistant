import { type DurableFlowEngine as FlowEngine } from '../../../../packages/plugin-sdk/src/durable-flow';
import type { PluginRuntimeContext } from './runtime';
import { type PluginCommandContext } from './runtime';
import type { CommandContext } from '../../../../packages/plugin-sdk/src/commands';
import { type TranslateFn } from '../../../../packages/plugin-sdk/src/i18n';
import type { WorkflowRunRecord } from '../../../../packages/plugin-sdk/src/workflow-store';
import { workflowDigest, type WorkflowPrincipal } from '../../../../packages/plugin-sdk/src/workflows';
import { getPollOutcomeConfiguration, listPollOutcomeHandoffs } from './outcomeStore';
import { getPollAggregate, ensurePollLifecycleDelivery, pollsDatabase } from './store';
import { enqueuePollDeliveryJob } from './jobs';

const APPROVAL_PURPOSE = 'poll-assistant.outcome-approval.v1';
const registered = new WeakSet<FlowEngine>();

export function registerPollOutcomeApprovals(engine: FlowEngine): void {
  if (!engine.registerPromptHandler || registered.has(engine)) return;
  engine.registerPromptHandler(APPROVAL_PURPOSE, async (lock) => {
    if (!lock.subjectId || lock.selectedOptions.length !== 1) return false;
    const [decision, digest] = lock.selectedOptions[0]!.id.split(':');
    if (!digest || (decision !== 'confirm' && decision !== 'cancel')) return false;
    const run = await engine.workflowRuns.get(lock.subjectId);
    if (!run || run.state.principal.source !== 'poll_outcome' || run.state.principal.actorIdentityId !== lock.voterIdentityId) return false;
    await engine.workflowRuns.approve(run.id, lock.voterIdentityId, digest, decision, lock.flowPromptId);
    await engine.enqueueWorkflowRun(run.id);
    await engine.acknowledgePromptLock(lock.flowPromptId);
    return true;
  }, { recoverLocked: true });
  registered.add(engine);
}

export async function promptPollOutcomeApproval(engine: FlowEngine, run: WorkflowRunRecord, t: TranslateFn): Promise<void> {
  await engine.promptChoice({ purpose: APPROVAL_PURPOSE, subjectType: 'PollOutcome', subjectId: run.id,
    question: t('official.poll-assistant.outcome.approval', { summary: run.state.summary }),
    options: [{ id: `confirm:${run.state.proposalDigest}`, label: t('official.poll-assistant.outcome.confirm') },
      { id: `cancel:${run.state.proposalDigest}`, label: t('official.poll-assistant.outcome.cancel') }],
    recipientWids: [run.state.principal.chatId], eligibleVoterIdentityIds: [run.state.principal.actorIdentityId],
    expiresAt: new Date(run.state.approvalExpiresAt!),
    questionSendOptions: { idempotencyKey: `${run.id}:approval:${run.revision}` } });
}

/** SQLite owns the final decision and handoff. PostgreSQL owns execution; both sides can retry. */
export async function recoverPollOutcomes(context: PluginRuntimeContext, now = new Date()): Promise<number> {
  const engine = context.flowEngine;
  if (!engine?.workflowExecutor) return 0;
  registerPollOutcomeApprovals(engine);
  const db = pollsDatabase(context.databases);
  let processed = 0;
  for (const handoff of listPollOutcomeHandoffs(db)) {
    try {
      const aggregate = getPollAggregate(db, handoff.poll_id);
      const config = getPollOutcomeConfiguration(db, handoff.poll_id);
      if (!aggregate || !config || !await context.enabledFor(aggregate.poll.scopeId)) {
        // Rotate skipped entries too, so disabled scopes cannot starve another scope's handoff.
        db.run('UPDATE poll_outcome_handoffs SET updated_at = ? WHERE poll_id = ?', now.toISOString(), handoff.poll_id);
        continue;
      }
      const poll = aggregate.poll;
      const principal: WorkflowPrincipal = { runtimeBindingId: engine.workflowRuntimeBindingId, source: 'poll_outcome',
        scopeId: poll.scopeId, actorIdentityId: config.requesterIdentityId, chatId: config.requesterChatId,
        ...(poll.groupId ? { groupId: poll.groupId } : {}), groupWid: poll.chatId };
      let run = await engine.workflowRuns.create({ kind: 'actions', principal, sourceKey: `poll:${poll.id}:outcome`,
        request: poll.definition.question, summary: config.summary, program: config.program,
        sourceResult: JSON.parse(handoff.result_json), nodes: {},
        continuation: { frozenPolicy: { policy: config.policy, requesterIdentityId: config.requesterIdentityId,
          approvalSourceId: config.approvalSourceId, approvedAt: config.approvedAt, programDigest: config.programDigest } }
      }, 'preparing');
      if (run.status === 'preparing') run = await engine.workflowRuns.propose(run, new Date(now.getTime() + 24 * 60 * 60_000));
      // An automatic grant is recorded as policy authorization, never as a synthetic human click.
      if (run.status === 'awaiting_approval' && config.policy === 'automatic'
        && run.state.continuation?.review !== true && workflowDigest(run.state.program) === config.programDigest) {
        if (Date.parse(run.state.approvalExpiresAt!) <= now.getTime()) run = await engine.workflowRuns.propose(run, new Date(now.getTime() + 24 * 60 * 60_000));
        await engine.workflowRuns.approve(run.id, config.requesterIdentityId, run.state.proposalDigest!, 'policy', config.approvalSourceId);
        run = (await engine.workflowRuns.get(run.id))!;
      }
      db.run('UPDATE poll_outcome_handoffs SET workflow_run_id = ?, last_error = NULL, updated_at = ? WHERE poll_id = ?', run.id, now.toISOString(), poll.id);
      const t = await context.i18n.translatorForIdentity(config.requesterIdentityId, poll.scopeId);
      if (run.status === 'awaiting_approval' && Date.parse(run.state.approvalExpiresAt!) > now.getTime()) await promptPollOutcomeApproval(engine, run, t);
      if (['ready', 'running', 'pending'].includes(run.status)) await engine.enqueueWorkflowRun(run.id);
      const digest = workflowDigest([run.status, run.state.nodes]);
      if (digest !== handoff.reported_digest) {
        const deliveryId = `poll-outcome:${poll.id}:${digest}`;
        const delivery = ensurePollLifecycleDelivery(db, { pollId: poll.id, roundId: handoff.round_id, createdAt: now.toISOString(),
          delivery: { id: deliveryId, kind: 'announcement', deliveryKey: deliveryId, chatId: poll.chatId,
            text: renderPollOutcomeStatus(run, t), idempotencyKey: deliveryId } });
        await enqueuePollDeliveryJob(context, { scopeId: poll.scopeId, deliveryId, groupWid: poll.chatId,
          ...(poll.groupId ? { groupId: poll.groupId } : {}), attempt: delivery.attempt + 1 });
        db.run('UPDATE poll_outcome_handoffs SET reported_digest = ? WHERE poll_id = ?', digest, poll.id);
      }
      processed += 1;
    } catch (error) {
      db.run('UPDATE poll_outcome_handoffs SET last_error = ?, updated_at = ? WHERE poll_id = ?',
        error instanceof Error ? error.message : String(error), now.toISOString(), handoff.poll_id);
    }
  }
  return processed;
}

export function renderPollOutcomeStatus(run: WorkflowRunRecord, t: TranslateFn): string {
  const nodes = run.state.program?.nodes.map((node) => {
    const state = run.state.nodes[node.id];
    const result = state?.result;
    return `${node.id}: ${t(`official.poll-assistant.outcome.status.${state?.status ?? 'ready'}`)}${result ? ` — ${'summary' in result ? result.summary : result.reason}` : ''}`;
  }) ?? [];
  return t('official.poll-assistant.outcome.status', { question: run.state.request,
    status: t(`official.poll-assistant.outcome.status.${run.status}`), actions: nodes.join('\n') });
}

export async function pollActionsCommand(context: PluginCommandContext, ctx: CommandContext) {
  const args = ctx.remainingArgs ?? ctx.command.args;
  const pollId = args[0];
  const actorIdentityId = ctx.actor?.identityAddress.identityId;
  const engine = context.flowEngine;
  const aggregate = pollId ? getPollAggregate(pollsDatabase(context.databases), pollId) : undefined;
  if (!aggregate || aggregate.poll.scopeId !== ctx.scopeId || (ctx.groupWid && aggregate.poll.chatId !== ctx.groupWid) || !actorIdentityId) return { handled: true, text: ctx.t('official.poll-assistant.outcome.unavailable') };
  const db = pollsDatabase(context.databases);
  const config = getPollOutcomeConfiguration(db, aggregate.poll.id);
  const handoff = db.get<{ workflow_run_id: string | null }>('SELECT workflow_run_id FROM poll_outcome_handoffs WHERE poll_id = ?', aggregate.poll.id);
  let run = handoff?.workflow_run_id ? await engine.workflowRuns.get(handoff.workflow_run_id) : undefined;
  if (!config) return { handled: true, text: ctx.t('official.poll-assistant.outcome.none') };
  // Consequences are public; only the original requester can change their execution.
  const action = args[1] ?? 'status';
  if (action !== 'status' && config.requesterIdentityId !== actorIdentityId) return { handled: true, text: ctx.t('official.poll-assistant.outcome.requesterOnly') };
  if (!run) return { handled: true, text: ctx.t('official.poll-assistant.outcome.waiting', { summary: config.summary }) };
  if (action === 'cancel') await engine.workflowRuns.cancel(run.id, actorIdentityId);
  else if (action === 'retry') await engine.workflowExecutor?.retry(run.id, actorIdentityId);
  else if (action === 'review' && !run.leaseToken && !['completed', 'cancelled'].includes(run.status)) {
    if (!engine.workflowActions) throw new Error('Workflow catalog unavailable');
    const nodes = [];
    for (const node of run.state.program!.nodes) {
      const state = run.state.nodes[node.id];
      if (state?.status === 'completed' || state?.status === 'skipped' || state?.status === 'pending' || state?.status === 'running') nodes.push(node);
      else {
        nodes.push({ ...node, prepared: await engine.workflowActions.prepare(run.state.principal, node) });
        run.state.nodes[node.id] = { status: 'ready', attempts: 0, generation: (state?.generation ?? 0) + 1 };
      }
    }
    run.state.program = { version: 1, nodes };
    run.state.summary = nodes.map((node) => node.prepared!.summary).join('\n\n');
    run.state.continuation = { ...run.state.continuation, review: true };
    run = await engine.workflowRuns.propose(run, new Date(Date.now() + 10 * 60_000));
    await promptPollOutcomeApproval(engine, run, ctx.t);
  }
  run = (await engine.workflowRuns.get(run.id))!;
  return { handled: true, text: renderPollOutcomeStatus(run, ctx.t) };
}
