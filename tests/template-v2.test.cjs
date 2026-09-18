const assert = require('node:assert/strict');
const { test } = require('node:test');
const { previewTemplateFragment } = require('@wabs/plugin-sdk/templates');
const { pollTemplateFields, renderPollTemplateFragment, pollTemplateIssues, POLL_DEFAULT_PUBLICATION } = require('../dist/templates');
const { migratePollTemplateLayers } = require('../dist/templateMigration');
const { resolvePollMessage } = require('../dist/templateDelivery');
const pt = require('../locales/pt-PT/official.poll-assistant.json');
const t = (key, params) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => String(params?.[name] ?? token));

test('account runtime migration persists templates even when package installation ran in the console account', async () => {
  const plugin = require('../dist').default;
  let applied;
  await plugin.lifecycle.migrateData({ whatsAppAccountId: 'real-account', logger: { info() {} },
    migrateConfiguration: async (key, transform) => {
      assert.equal(key, 'message-templates-v2');
      applied = transform({ scopes: [{ id: 'scope', parentScopeId: null }], layers: [
        { id: 'instance', scopeId: 'scope', config: { messages: { publication: 'Custom {question}', mentionEligible: false } } }
      ] });
      return { changed: applied.length, backupKey: 'real-account-backup' };
    } });
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].config.messages, { publication: 'Custom {question}', templateVersion: 2 });
});

test('ballot delivery compares canonical choices independently of display language', () => {
  const source = '{{#if ballotDelivery == "private"}}Privado{{else}}Grupo{{/if}}';
  assert.equal(pollTemplateFields('publication').find(field => field.token === 'ballotDelivery').valueType, 'enum');
  assert.deepEqual(pollTemplateIssues('publication', source), []);
  for (const label of ['Private', 'Privado', 'Privat']) {
    const fragment = renderPollTemplateFragment({ kind: 'publication', overrides: { publication: source }, t,
      values: { ballotDelivery: label }, conditionValues: { ballotDelivery: 'private' } });
    assert.equal(previewTemplateFragment(fragment), 'Privado');
  }
  assert.ok(pollTemplateIssues('publication', '{{#if ballotDelivery > 1}}x{{/if}}').length);
});

test('closed publication accepts publication fields and canonical conditions', () => {
  const source = '❌ ENCERRADA ❌\n{{#if ballotDelivery == "group"}}Sondagem “{question}”{{else}}Sondagem privada “{question}”{{/if}}\nFinalidade: {purpose}\nPrazo: Até às {closing}';
  const fields = pollTemplateFields('closedPublication');
  assert.equal(fields.find(field => field.token === 'ballotDelivery').valueType, 'enum');
  assert.ok(fields.some(field => field.token === 'purpose'));
  assert.ok(fields.some(field => field.token === 'closing'));
  assert.deepEqual(pollTemplateIssues('closedPublication', source), []);
  const fragment = renderPollTemplateFragment({ kind: 'closedPublication', overrides: { closedPublication: source }, t,
    values: { question: 'Manhã ou tarde?', ballotDelivery: 'Grupo', purpose: 'Decisão', closing: '12:22' },
    conditionValues: { ballotDelivery: 'group', purpose: 'decide' } });
  assert.equal(previewTemplateFragment(fragment), '❌ ENCERRADA ❌\nSondagem “Manhã ou tarde?”\nFinalidade: Decisão\nPrazo: Até às 12:22');
});

test('hidden nested rows cannot resolve or notify a recipient', async () => {
  const row = renderPollTemplateFragment({ kind: 'resultOption', t, overrides: { resultOption: '{{#if count > 0}}{{mention target "eligibleVoters"}}{{else}}No votes{{/if}}' }, values: { count: 0 } });
  const fragment = renderPollTemplateFragment({ kind: 'result', t, overrides: { result: '{optionResults}' }, values: { optionResults: row } });
  const messages = await resolvePollMessage({ resolveStableIdentityById: async () => { throw new Error('Unexpected resolution'); } },
    { id: 'poll', scopeId: 'scope', chatId: '123@g.us', creatorIdentityId: 'creator' }, fragment);
  assert.deepEqual(messages, [{ text: 'No votes' }]);
});

test('native group links use the protocol address and retain readable group subjects', async () => {
  const fragment = renderPollTemplateFragment({ kind: 'activation', t, overrides: { activation: '{{mention group "123@g.us" "Old name"}} {{mention all}}' }, values: {} });
  const messages = await resolvePollMessage({ coveredGroupsForScope: async () => [{ groupWid: '123@g.us', groupDisplayName: 'Walks' }] },
    { id: 'poll', scopeId: 'scope', chatId: '456@g.us', creatorIdentityId: 'creator' }, fragment);
  assert.deepEqual(messages, [{ text: '@123@g.us @all', inlineMentions: true, mentionAll: true, groupMentions: [{ groupJid: '123@g.us', groupSubject: 'Walks' }] }]);
});

test('migration preserves effective notification overrides, original prose and repeatability', () => {
  const input = { scopes: [{ id: 'root', parentScopeId: null }, { id: 'child', parentScopeId: 'root' }, { id: 'leaf', parentScopeId: 'child' }], layers: [
    { id: 'r', scopeId: 'root', config: { messages: { mentionEligible: false, publication: '  Olá {question}  ' }, other: 4 } },
    { id: 'c', scopeId: 'child', config: { messages: { mentionEligible: true } } },
    { id: 'l', scopeId: 'leaf', config: { messages: { publication: 'Custom leaf {question}' } } }
  ] };
  const original = JSON.stringify(input);
  const patches = migratePollTemplateLayers(input);
  assert.equal(JSON.stringify(input), original);
  assert.equal(patches[0].config.messages.publication, '  Olá {question}  ');
  assert.equal(patches[0].config.other, 4);
  assert.equal(patches[1].config.messages.publication, POLL_DEFAULT_PUBLICATION.split('\n')[0] + '\n  Olá {question}  ');
  assert.equal(patches[2].config.messages.publication, POLL_DEFAULT_PUBLICATION.split('\n')[0] + '\nCustom leaf {question}');
  assert.ok(patches.every(patch => patch.config.messages.mentionEligible === undefined));
  const migrated = { ...input, layers: input.layers.map(layer => ({ ...layer, config: patches.find(patch => patch.scopeId === layer.scopeId).config })) };
  assert.deepEqual(migratePollTemplateLayers(migrated), []);
});

test('migration keeps localized defaults as fragments and expands identity-wide overrides per scope', () => {
  const patches = migratePollTemplateLayers({ scopes: [{ id: 'root', parentScopeId: null }, { id: 'child', parentScopeId: 'root' }], layers: [
    { id: 'r', scopeId: 'root', config: { messages: { publication: 'Root prose', mentionEligible: true } } },
    { id: 'c', scopeId: 'child', config: { messages: { publication: 'Child prose' } } },
    { id: 'u', scopeId: null, identityId: 'user', config: { messages: { mentionEligible: false } } }
  ] });
  assert.equal(patches.find(patch => patch.identityId === 'user' && patch.scopeId === null).config.messages.publication, '{{default}}');
  assert.equal(patches.find(patch => patch.identityId === 'user' && patch.scopeId === 'root').config.messages.publication, 'Root prose');
  assert.equal(patches.find(patch => patch.identityId === 'user' && patch.scopeId === 'child').config.messages.publication, 'Child prose');
});
