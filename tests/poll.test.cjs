const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const plugin = require('../dist').default;
const { pollDefinitionSchema } = require('../dist/domain');
const { createPoll, getPollAggregate, getPollDelivery, ensurePollLifecycleDelivery,
  listPollRoundIdsMissingAnnouncements } = require('../dist/store');
const { enqueuePollPublishJob } = require('../dist/jobs');
const { publishPollRound } = require('../dist/publication');
const { TransportProviderUnavailableError } = require('@wabs/plugin-sdk/transport-errors');
const { renderPollTemplate, paginatePollText, pollTemplateSamples } = require('../dist/templates');
const { parsePollAssistantConfig } = require('../dist/config');
const { resolveCreationDefinition } = require('../dist/createAction');
const { closePoll } = require('../dist/commands');
const pt = require('../locales/pt-PT/official.poll-assistant.json');
const t = (key, params) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => String(params?.[name] ?? token));
const timestamp = '2026-09-12T10:00:00.000Z';
const cutoff = '2026-09-12T11:22:57.000Z';
const migrations = fs.readdirSync(path.resolve('migrations/polls')).filter(name => name.endsWith('.sql')).sort();

function open(filePath) {
  const sqlite = new DatabaseSync(filePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return { name: 'polls', filePath, exec: sql => sqlite.exec(sql), prepare: sql => sqlite.prepare(sql),
    get: (sql, ...args) => sqlite.prepare(sql).get(...args), all: (sql, ...args) => sqlite.prepare(sql).all(...args),
    run: (sql, ...args) => sqlite.prepare(sql).run(...args), close: () => sqlite.close(),
    transaction(operation) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = operation(); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
}
function migrate(db, names) {
  for (const name of names) db.exec(fs.readFileSync(path.join('migrations/polls', name), 'utf8'));
}
function seed(db) {
  const definition = pollDefinitionSchema.parse({ schemaVersion: 1, id: 'fixture-poll', purpose: 'decide',
    question: 'Manhã ou tarde?', options: [{ id: 'am', label: 'Manhã', ordinal: 1 }, { id: 'pm', label: 'Tarde', ordinal: 2 }],
    rule: { kind: 'plurality' }, tiePolicy: { kind: 'authorized_choice' },
    closing: { kind: 'deadline', deadline: { mode: 'at', closesAt: cutoff } },
    quorum: { kind: 'none' }, electorate: { kind: 'members_at_publication' } });
  return createPoll(db, { definition, scopeId: 'fixture-scope', chatId: 'fixture@g.us',
    creatorIdentityId: 'fixture-actor', creatorWid: 'fixture@c.us', creatorLabel: 'Fixture actor',
    roundId: 'fixture-round', publishIdempotencyKey: 'fixture-publish', maxActivePollsPerChat: 10, createdAt: timestamp });
}

test('assistant creation resolves scoped defaults and fixed presets before approval', () => {
  const config = parsePollAssistantConfig({
    defaultClosingMode: 'manual', defaultQuorumMode: 'absolute', defaultAbsoluteQuorumResponses: 3,
    creationPresets: [{ id: 'quick', label: 'Quick', isDefault: true,
      closing: { mode: 'fixed', kind: 'duration', durationMinutes: 30 },
      quorum: { mode: 'fixed', kind: 'percentage', minimumTurnoutBasisPoints: 6000 },
      decideRule: { mode: 'fixed', kind: 'approval' } }]
  });
  const draft = { purpose: 'decide', question: 'Morning or afternoon?',
    options: [{ id: 'one', label: 'Morning', ordinal: 1 }, { id: 'two', label: 'Afternoon', ordinal: 2 }] };
  const resolved = resolveCreationDefinition(draft, config);
  assert.deepEqual(resolved.closing, { kind: 'deadline', deadline: { mode: 'after_publish', durationMinutes: 30 } });
  assert.deepEqual(resolved.quorum, { kind: 'percentage', minimumTurnoutBasisPoints: 6000 });
  assert.deepEqual(resolved.rule, { kind: 'approval' });
  assert.throws(() => resolveCreationDefinition({ ...draft, closing: { kind: 'manual' } }, config), /fixes closing/);
  const scoped = resolveCreationDefinition(draft, parsePollAssistantConfig({ defaultClosingMode: 'manual',
    defaultQuorumMode: 'absolute', defaultAbsoluteQuorumResponses: 3 }));
  assert.deepEqual(scoped.closing, { kind: 'manual' });
  assert.deepEqual(scoped.quorum, { kind: 'absolute', minimumResponses: 3 });
  const shared = resolveCreationDefinition(draft, parsePollAssistantConfig({
    defaultClosingMode: 'manual', defaultQuorumMode: 'none',
    creationPresets: [{ id: 'shared', label: 'Shared', isDefault: true,
      closing: { mode: 'ask', kind: 'duration', durationMinutes: 20 },
      quorum: { mode: 'ask', kind: 'percentage', minimumTurnoutBasisPoints: 6000 },
      ballotDelivery: { mode: 'ask', value: 'private' },
      voterDisclosure: { mode: 'ask', value: 'named' } }]
  }));
  assert.deepEqual(shared.closing, { kind: 'deadline', deadline: { mode: 'after_publish', durationMinutes: 20 } });
  assert.deepEqual(shared.quorum, { kind: 'percentage', minimumTurnoutBasisPoints: 6000 });
  assert.equal(shared.ballotDelivery, 'private');
});

test('new count polls reject zero while legacy stored zero values remain readable', () => {
  const db = open(':memory:'); migrate(db, migrations);
  try {
    const definition = pollDefinitionSchema.parse({ schemaVersion: 1, id: 'count-poll', purpose: 'count',
      question: 'How many?', options: [{ id: 'one', label: 'One', ordinal: 1, numericValue: 1 },
        { id: 'two', label: 'Two', ordinal: 2, numericValue: 2 }],
      rule: { kind: 'sum', unit: 'items' }, closing: { kind: 'manual' }, quorum: { kind: 'none' },
      electorate: { kind: 'members_at_publication' } });
    const input = { definition, scopeId: 'fixture-scope', chatId: 'fixture@g.us',
      creatorIdentityId: 'fixture-actor', creatorWid: 'fixture@c.us', creatorLabel: 'Fixture actor',
      roundId: 'count-round', publishIdempotencyKey: 'count-publish', maxActivePollsPerChat: 10, createdAt: timestamp };
    assert.throws(() => createPoll(db, { ...input, definition: { ...definition, options: [
      { ...definition.options[0], numericValue: 0 }, definition.options[1]
    ] } }), /greater than zero/);
    createPoll(db, input);
    db.run('UPDATE polls SET definition_json = ? WHERE id = ?', JSON.stringify({ ...definition,
      options: [{ ...definition.options[0], numericValue: 0 }, definition.options[1]] }), definition.id);
    db.run('UPDATE poll_options SET numeric_value = 0 WHERE poll_id = ? AND id = ?', definition.id, 'one');
    assert.equal(getPollAggregate(db, definition.id).poll.definition.options[0].numericValue, 0);
  } finally { db.close(); }
});

test('close asks for confirmation with one open poll and selection with several', async () => {
  const db = open(':memory:'); migrate(db, migrations);
  try {
    seed(db);
    db.run("UPDATE poll_rounds SET status = 'open', closes_at = '2030-01-01T00:00:00.000Z' WHERE id = 'fixture-round'");
    const prompts = [];
    const context = { pluginId: plugin.manifest.pluginId, manifest: plugin.manifest,
      dataStore: {}, configFor: async () => ({}), ephemeralStore: {}, setConfig: async () => undefined,
      enqueuePluginJob: async () => undefined, databases: { open: () => db },
      flowEngine: { promptChoice: async input => { prompts.push(input); return { flowPromptId: String(prompts.length), messageIds: [] }; } },
      i18n: { translatorForScope: async () => t } };
    const command = { scopeId: 'fixture-scope', groupWid: 'fixture@g.us', locale: 'pt-PT', t,
      actor: { identityAddress: { identityId: 'fixture-actor' } },
      message: { id: 'close-one', chatId: 'fixture@g.us', context: 'group' },
      command: { args: [] }, remainingArgs: [] };
    assert.deepEqual(await closePoll(context, command), { handled: true });
    assert.equal(prompts[0].purpose, 'official.poll-assistant.close.confirm.v1');
    assert.equal(prompts[0].options[0].id, 'confirm');
    assert.equal(db.get('SELECT status FROM poll_rounds WHERE id = ?', 'fixture-round').status, 'open');

    const prior = getPollAggregate(db, 'fixture-poll').poll.definition;
    createPoll(db, { definition: { ...prior, id: 'second-poll', question: 'Outra pergunta?' },
      scopeId: 'fixture-scope', chatId: 'fixture@g.us', creatorIdentityId: 'fixture-actor',
      creatorWid: 'fixture@c.us', creatorLabel: 'Fixture actor', roundId: 'second-round',
      publishIdempotencyKey: 'second-publish', maxActivePollsPerChat: 10, createdAt: timestamp });
    db.run("UPDATE poll_rounds SET status = 'open', closes_at = '2030-01-01T00:00:00.000Z' WHERE id = 'second-round'");
    assert.deepEqual(await closePoll(context, { ...command, message: { ...command.message, id: 'close-many' } }), { handled: true });
    assert.equal(prompts[1].purpose, 'official.poll-assistant.close.select.v1');
    assert.deepEqual(prompts[1].options.map(option => option.id).sort(), ['fixture-poll', 'second-poll']);
    assert.equal(db.get('SELECT status FROM poll_rounds WHERE id = ?', 'second-round').status, 'open');
  } finally { db.close(); }
});

test('publication sends one durable introduction before the native poll across retries', async () => {
  const db = open(':memory:'); migrate(db, migrations);
  try {
    const aggregate = seed(db);
    const calls = [];
    let publishAttempts = 0;
    const ctx = { pluginId: plugin.manifest.pluginId, databases: { open: () => db },
      configFor: async () => ({}),
      i18n: { translatorForScope: async () => t, resolveScopeLocale: async () => ({ locale: 'pt-PT' }) },
      resolveIdentityAddress: async wid => ({ identityId: wid, canonicalWid: wid, deliveryChatId: wid }),
      resolveStableIdentityById: async identityId => ({ identityId, canonicalWid: '351900000001@c.us', mentionWid: '351900000001@c.us', deliveryChatId: '351900000001@c.us' }),
      getAuthoritativeGroupParticipantSnapshot: async () => ({ providerId: 'whatsmeow', observedAt: new Date(timestamp),
        botWid: 'bot@c.us', participants: [{ wid: 'fixture@c.us', displayName: 'Fixture actor' }] }),
      sendText: async (_chatId, _text, options) => { calls.push(['introduction', options.idempotencyKey]);
        return { messageId: 'intro-message' }; },
      services: { call: async request => {
        if (request.method === 'reconcilePoll') return { status: 'absent' };
        calls.push(['poll', request.input.idempotencyKey]);
        publishAttempts += 1;
        if (publishAttempts === 1) throw new TransportProviderUnavailableError('whatsmeow', 'offline');
        return { messageId: 'native-poll', acceptedAt: timestamp };
      } },
      enqueuePluginJob: async () => undefined };
    await publishPollRound(ctx, aggregate.poll.id, aggregate.rounds[0].id, () => new Date(timestamp));
    assert.equal(getPollDelivery(db, 'poll-announcement:fixture-round:published')?.status, 'sent',
      JSON.stringify({ round: db.get('SELECT status, last_error, publication_next_attempt_at FROM poll_rounds WHERE id = ?', 'fixture-round'), calls }));
    const next = db.get('SELECT publication_next_attempt_at FROM poll_rounds WHERE id = ?', 'fixture-round').publication_next_attempt_at;
    await publishPollRound(ctx, aggregate.poll.id, aggregate.rounds[0].id, () => new Date(next));
    assert.deepEqual(calls.map(([kind]) => kind), ['introduction', 'poll', 'poll']);
    assert.equal(getPollAggregate(db, aggregate.poll.id).rounds[0].pollWaMessageId, 'native-poll');
  } finally { db.close(); }
});

test('data version 7 retains old deliveries and identifiers, then reloads frozen new writes after restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-poll-fixture-'));
  let db;
  try {
    const file = path.join(directory, 'polls.sqlite');
    db = open(file);
    migrate(db, migrations.slice(0, 5));
    seed(db);
    db.run(`INSERT INTO poll_deliveries (id, poll_id, round_id, kind, delivery_key, chat_id, text,
      idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'old-delivery', 'fixture-poll', 'fixture-round', 'result', 'old-key', 'fixture@g.us',
      'Existing queued content', 'old-idempotency', 'pending', timestamp, timestamp);
    const old = { ...db.get('SELECT * FROM poll_deliveries WHERE id = ?', 'old-delivery') };
    const priorDefinition = db.get('SELECT definition_json FROM polls').definition_json;
    migrate(db, migrations.slice(5));
    const next = { ...db.get('SELECT * FROM poll_deliveries WHERE id = ?', 'old-delivery') };
    assert.equal(next.mentioned_wids_json, '[]');
    delete next.mentioned_wids_json;
    assert.equal(next.template_mentions_json, '{}');
    delete next.template_mentions_json;
    assert.deepEqual(next, old);
    assert.equal(db.get('SELECT definition_json FROM polls').definition_json, priorDefinition);
    assert.deepEqual(getPollDelivery(db, 'old-delivery').mentionedWids ?? [], []);
    const input = { pollId: 'fixture-poll', roundId: 'fixture-round', createdAt: timestamp,
      activationAnnouncementEnabled: false, reuseExistingAnnouncement: true,
      delivery: { id: 'poll-announcement:fixture-round:published', kind: 'announcement', deliveryKey: 'notice-key',
        chatId: 'fixture@g.us', text: 'Frozen custom publication', mentionedWids: ['one@c.us', 'one@c.us', 'two@c.us'], idempotencyKey: 'notice-idempotency' } };
    const saved = ensurePollLifecycleDelivery(db, input);
    assert.deepEqual(saved.mentionedWids, ['one@c.us', 'two@c.us']);
    db.run(`UPDATE poll_rounds SET published_at = ?, activated_at = ?, activation_trigger_kind = 'participant_response' WHERE id = ?`, timestamp, timestamp, 'fixture-round');
    db.close(); db = open(file);
    const replay = ensurePollLifecycleDelivery(db, { ...input,
      delivery: { ...input.delivery, text: 'Later configuration', mentionedWids: ['new@c.us'] } });
    assert.equal(replay.text, saved.text);
    assert.deepEqual(replay.mentionedWids, saved.mentionedWids);
    assert.equal(getPollAggregate(db, 'fixture-poll').rounds[0].closesAt, cutoff);
    assert.deepEqual(listPollRoundIdsMissingAnnouncements(db), []);
    assert.throws(() => ensurePollLifecycleDelivery(db, { pollId: input.pollId, roundId: input.roundId, createdAt: timestamp,
      delivery: { ...input.delivery, mentionedWids: [], kind: 'activation', id: 'activation', deliveryKey: 'activation-key', idempotencyKey: 'activation-idempotency' } }), /suppressed/);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    db?.close();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('wabs-poll-fixture-')) throw new Error('Unexpected cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publication retry keeps its payload and deduplication key and propagates host queue failures', async () => {
  const calls = [];
  const context = { pluginId: plugin.manifest.pluginId, enqueuePluginJob: async input => {
    calls.push(input);
    if (calls.length === 1) throw new Error('Fixture queue unavailable');
  } };
  const input = { scopeId: 'fixture-scope', pollId: 'fixture-poll', roundId: 'fixture-round',
    groupWid: 'fixture@g.us', attempt: 0, runAt: new Date(timestamp) };
  await assert.rejects(enqueuePollPublishJob(context, input), /queue unavailable/);
  await enqueuePollPublishJob(context, input);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].pluginId, undefined);
  assert.deepEqual(calls[0].payload, { pollId: input.pollId, roundId: input.roundId });
  await assert.rejects(enqueuePollPublishJob({ ...context, pluginId: 'unrelated-plugin' }, input), /matching host-bound/);
});

test('stored settings and template overrides survive parsing, while invalid saves are rejected', () => {
  const custom = { maxActivePollsPerChat: 7, messages: { result: 'My result: {question}', mentionEligible: false, activationEnabled: true } };
  const original = JSON.stringify(custom);
  const parsed = plugin.manifest.configSchema.parse(custom);
  assert.equal(parsed.maxActivePollsPerChat, 7);
  for (const [key, value] of Object.entries(custom.messages)) if (key !== 'mentionEligible') assert.equal(parsed.messages[key], value);
  assert.equal(parsed.messages.mentionEligible, undefined);
  assert.equal(parsed.messages.templateVersion, 2);
  assert.equal(parsed.messages.publication, '{{default}}');
  assert.equal(JSON.stringify(custom), original);
  assert.throws(() => plugin.manifest.configSchema.parse({ messages: { result: '{unknown}' } }), /unknown template variable/i);
  const legacy = { messages: { result: '{unknown}' } };
  const diagnostics = [];
  const text = renderPollTemplate({ kind: 'result', t, values: pollTemplateSamples,
    overrides: parsePollAssistantConfig(legacy).messages, diagnostic: input => diagnostics.push(input) });
  assert.match(text, /Sondagem encerrada/);
  assert.equal(diagnostics.length, 1);
  assert.equal(legacy.messages.result, '{unknown}');
});

test('Portuguese templates distinguish response and electorate percentages without revealing unavailable identities', () => {
  const values = { option: 'Tarde', count: 2, respondentPercent: 100, eligiblePercent: 50, voters: 'Ana, Rui' };
  assert.equal(renderPollTemplate({ kind: 'resultOption', t, values }), 'Tarde: 2 resposta(s) (100% dos participantes) (Ana, Rui)');
  assert.equal(renderPollTemplate({ kind: 'resultOption', t, values,
    overrides: { resultOption: '{option}: {eligiblePercent}% dos elegíveis' } }), 'Tarde: 50% dos elegíveis');
  const hidden = renderPollTemplate({ kind: 'resultOption', t, values: { ...values, voters: undefined, voterIdentityId: 'secret-identity' } });
  assert.equal(hidden, 'Tarde: 2 resposta(s) (100% dos participantes)');
});

test('assistant proposal template has one bold rule and configurable option rows', () => {
  const options = [
    renderPollTemplate({ kind: 'proposalOption', t, values: { ordinal: 1, label: '1', numericValue: 1, option: '1 = 1' } }),
    renderPollTemplate({ kind: 'proposalOption', t, values: { ordinal: 2, label: '2', numericValue: 2, option: '2 = 2' } })
  ].join('\n');
  assert.equal(options, '1) - 1 = 1\n2) - 2 = 2');
  const values = { ...pollTemplateSamples, question: 'Quantos cafés?', options, rule: 'Somar os cafés', consequences: undefined };
  const proposal = renderPollTemplate({ kind: 'assistantProposal', t, values });
  assert.match(proposal, /\*Pergunta\*\nQuantos cafés\?/);
  assert.match(proposal, /\*Opções\*\n1\) - 1 = 1/);
  assert.equal((proposal.match(/\*Regra\*/g) ?? []).length, 1);
  assert.match(proposal, /\*Regra\*: Somar os cafés/);
  assert.doesNotMatch(proposal, /\*Regra\*\n/);
  const configured = plugin.manifest.configSchema.parse({ messages: {
    proposalOption: '{ordinal}. {label}', assistantProposal: '{question}\n{options}'
  } });
  assert.equal(renderPollTemplate({ kind: 'proposalOption', t, values: { ordinal: 1, label: '1', option: '1 = 1' }, overrides: configured.messages }), '1. 1');
  assert.equal(renderPollTemplate({ kind: 'assistantProposal', t, values, overrides: configured.messages }), 'Quantos cafés?\n1) - 1 = 1\n2) - 2 = 2');
});

test('long result pages preserve every Unicode codepoint and blank overrides restore localized defaults', () => {
  const text = 'Sondagem\n' + Array.from({ length: 900 }, (_, i) => `Pessoa ${i} 🌊`).join(', ');
  const pages = paginatePollText(text);
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => [...page].length <= 3500));
  assert.equal(pages.join(''), text);
  assert.equal(renderPollTemplate({ kind: 'publication', t, values: pollTemplateSamples, overrides: { publication: '  ' } }),
    renderPollTemplate({ kind: 'publication', t, values: pollTemplateSamples }));
});

test('the archive retains every SQL migration and all declared translations and controls', () => {
  const metadata = require('../wa-plugin.json');
  assert.deepEqual(metadata.workflowActions, plugin.manifest.workflowActions);
  assert.equal(metadata.dataVersion, '9');
  assert.equal(metadata.databases[0].name, 'polls');
  assert.equal(migrations.length, 8);
  for (const migration of migrations) assert.equal(fs.readFileSync(path.join('migrations/polls', migration), 'utf8'), fs.readFileSync(path.join('src/migrations/polls', migration), 'utf8'));
  for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
  assert.equal(typeof plugin.lifecycle.onUpdate, 'function');
  assert.ok(metadata.operatorConsole.controls.length > 20);
  const runtimeControls = require('../dist/controls').pollAssistantControls;
  assert.deepEqual(metadata.operatorConsole.controls.map(({ path, label, section, order, ui }) =>
    ({ path, label, section, order, builderId: ui.builderId ?? null })),
  runtimeControls.map((control) => ({ path: control.storage.path, label: control.label,
    section: control.section, order: control.order, builderId: control.ui.builderId ?? null })));
});

test('publication pages are atomic and retries keep their original text and page-local recipients', () => {
  const { ensurePollLifecycleDeliveryBatch } = require('../dist/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-poll-fixture-'));
  const db = open(path.join(directory, 'polls.sqlite'));
  try {
    migrate(db, migrations); seed(db);
    const inputs = [0, 1].map(index => ({ pollId: 'fixture-poll', roundId: 'fixture-round', createdAt: timestamp,
      activationAnnouncementEnabled: false, reuseExistingAnnouncement: true,
      delivery: { id: index ? 'page-2' : 'poll-announcement:fixture-round:published', kind: 'announcement', deliveryKey: 'page-' + index,
        chatId: '123@g.us', text: index ? '@456@g.us' : '@123 @all', mentionedWids: index ? [] : ['123@c.us'],
        ...(index ? { groupMentions: [{ groupJid: '456@g.us', groupSubject: 'Walks' }] } : { mentionAll: true }),
        idempotencyKey: 'page-' + index, deliveryBatchKey: 'frozen-batch', deliverySequence: index } }));
    assert.throws(() => ensurePollLifecycleDeliveryBatch(db, [inputs[0], { ...inputs[1], delivery: { ...inputs[1].delivery, text: '' } }]));
    assert.equal(getPollDelivery(db, inputs[0].delivery.id), undefined);
    ensurePollLifecycleDeliveryBatch(db, inputs);
    const before = db.all('SELECT * FROM poll_deliveries ORDER BY id').map(row => ({ ...row }));
    ensurePollLifecycleDeliveryBatch(db, inputs.map(input => ({ ...input, delivery: { ...input.delivery, text: 'New config', mentionedWids: [] } })));
    assert.deepEqual(db.all('SELECT * FROM poll_deliveries ORDER BY id').map(row => ({ ...row })), before);
    assert.deepEqual(getPollDelivery(db, 'page-2').groupMentions, inputs[1].delivery.groupMentions);
    assert.equal(getPollDelivery(db, 'poll-announcement:fixture-round:published').mentionAll, true);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('pins open polls, unpins on close, edits the existing publication once and retains state across sweeps', async () => {
  const { reconcilePollMessages } = require('../dist/messageLifecycle');
  const db = open(':memory:'); migrate(db, migrations); seed(db);
  db.run("UPDATE poll_rounds SET status = 'open', published_at = ?, poll_wa_message_id = 'native-poll'", timestamp);
  db.run(`INSERT INTO poll_deliveries (id, poll_id, round_id, kind, delivery_key, chat_id, text,
    idempotency_key, status, message_id, sent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'poll-announcement:fixture-round:published', 'fixture-poll', 'fixture-round', 'announcement', 'announcement-key',
    'fixture@g.us', 'Original publication', 'announcement-send-key', 'sent', 'publication-message', timestamp, timestamp, timestamp);
  const calls = [];
  const settings = { pinActivePolls: true, editPublicationOnClose: true, messages: {
    closedPublication: '{{#if ballotDelivery == "group"}}Encerrada: {question}{{else}}Encerrada em privado: {question}{{/if}}\nFinalidade: {purpose}\nPrazo: {closing}',
    templateVersion: 2
  } };
  const ctx = { databases: { open: () => db }, configFor: async () => settings,
    i18n: { translatorForScope: async () => t, resolveScopeLocale: async () => ({ locale: 'pt-PT' }) },
    pinMessage: async (...args) => calls.push(['pin', ...args]), unpinMessage: async (...args) => calls.push(['unpin', ...args]),
    editMessage: async (...args) => calls.push(['edit', ...args]), logger: { warn() {} }, audit: { record: async () => {} } };
  try {
    await reconcilePollMessages(ctx, new Date(timestamp));
    assert.deepEqual(calls, [['pin', 'native-poll', 2592000]]);
    db.run("UPDATE poll_rounds SET status = 'finalized', finalized_at = ?, closes_at = ?", '2026-09-12T10:02:00.000Z', '2026-09-12T10:02:00.000Z');
    db.run("UPDATE polls SET status = 'resolved'");
    await reconcilePollMessages(ctx, new Date('2026-09-12T10:02:00.000Z'));
    assert.equal(calls[1][0], 'unpin'); assert.equal(calls[1][1], 'native-poll');
    assert.equal(calls[2][0], 'edit'); assert.equal(calls[2][1], 'publication-message');
    assert.match(calls[2][2], /^Encerrada: Manhã ou tarde\?\nFinalidade: Decidir\nPrazo: /);
    await reconcilePollMessages(ctx, new Date('2026-09-12T10:04:00.000Z'));
    assert.equal(calls.length, 3);
  } finally { db.close(); }
});

test('disabled pinning cleans up managed pins and expired edits never send replacement messages', async () => {
  const { reconcilePollMessages } = require('../dist/messageLifecycle');
  const db = open(':memory:'); migrate(db, migrations); seed(db);
  db.run("UPDATE poll_rounds SET status = 'open', published_at = ?, poll_wa_message_id = 'native-poll'", timestamp);
  const calls = []; const audits = []; let enabled = true;
  const ctx = { databases: { open: () => db }, configFor: async () => ({ pinActivePolls: enabled, editPublicationOnClose: true }),
    pinMessage: async (...args) => calls.push(['pin', ...args]), unpinMessage: async (...args) => calls.push(['unpin', ...args]),
    editMessage: async () => { throw new Error('expired publication must not be edited'); },
    logger: { warn() {} }, audit: { record: async value => audits.push(value) } };
  try {
    await reconcilePollMessages(ctx, new Date(timestamp)); enabled = false;
    await reconcilePollMessages(ctx, new Date('2026-09-12T10:02:00.000Z'));
    assert.deepEqual(calls.map(call => call[0]), ['pin', 'unpin']);
    db.run(`INSERT INTO poll_deliveries (id, poll_id, round_id, kind, delivery_key, chat_id, text, idempotency_key, status, message_id, sent_at, created_at, updated_at)
      VALUES ('poll-announcement:fixture-round:published', 'fixture-poll', 'fixture-round', 'announcement', 'key', 'fixture@g.us', 'Original', 'send', 'sent', 'message', ?, ?, ?)`, timestamp, timestamp, timestamp);
    db.run("UPDATE poll_rounds SET status = 'finalized'"); db.run("UPDATE polls SET status = 'resolved'");
    await reconcilePollMessages(ctx, new Date('2026-09-12T11:30:00.000Z'));
    assert.equal(audits.at(-1).action, 'poll.publication.edit.unavailable');
    assert.equal(db.get('SELECT closed_edit_done FROM poll_message_lifecycle').closed_edit_done, 1);
  } finally { db.close(); }
});
