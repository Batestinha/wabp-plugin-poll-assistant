const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const previous = require('../dist').default;
const previousStore = require('../dist/store');
const previousAnnouncements = require('../dist/announcements');
const { deliverPollMessage } = require('../dist/delivery');
const forwardRoot = path.resolve('.cache/forward-poll-0.5.0/package');
const forward = require(path.join(forwardRoot, 'dist')).default;
const forwardStore = require(path.join(forwardRoot, 'dist/store'));
const { pollDefinitionSchema } = require('../dist/domain');
const { renderLegacyPublicationAnnouncement } = require('../dist/compatibilityAnnouncements');
const pt = require('../locales/pt-PT/official.poll-assistant.json');
const now = '2026-09-12T10:00:00.000Z';
const cutoff = '2026-09-12T11:22:57.000Z';
const t = (key, values) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => String(values?.[name] ?? token));
const migrations = fs.readdirSync('migrations/polls').filter(name => name.endsWith('.sql')).sort();

function open(filePath) {
  const sqlite = new DatabaseSync(filePath);
  sqlite.exec('PRAGMA foreign_keys=ON');
  return { name: 'polls', filePath, exec: sql => sqlite.exec(sql), prepare: sql => sqlite.prepare(sql),
    get: (sql, ...args) => sqlite.prepare(sql).get(...args), all: (sql, ...args) => sqlite.prepare(sql).all(...args),
    run: (sql, ...args) => sqlite.prepare(sql).run(...args), close: () => sqlite.close(),
    transaction(operation) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = operation(); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
}
function seed(db, id) {
  const definition = pollDefinitionSchema.parse({ schemaVersion: 1, id, purpose: 'decide', question: 'Morning or afternoon?',
    options: [{ id: 'am', label: 'Morning', ordinal: 1 }, { id: 'pm', label: 'Afternoon', ordinal: 2 }],
    rule: { kind: 'plurality' }, tiePolicy: { kind: 'authorized_choice' },
    closing: { kind: 'deadline', deadline: { mode: 'at', closesAt: cutoff } }, quorum: { kind: 'none' }, electorate: { kind: 'members_at_publication' } });
  previousStore.createPoll(db, { definition, scopeId: 'fixture-scope', chatId: 'fixture@g.us', creatorIdentityId: 'actor', creatorWid: 'actor@c.us',
    creatorLabel: 'Fixture actor', roundId: id+'-round', publishIdempotencyKey: id+'-publish', maxActivePollsPerChat: 10, createdAt: now });
  db.run('UPDATE poll_rounds SET published_at=?, announcements_required=1 WHERE id=?', now, id+'-round');
}
function context(db, config, sends = []) {
  return { pluginId: previous.manifest.pluginId, databases: { open: () => db }, configFor: async () => config,
    i18n: { translatorForScope: async () => t, resolveScopeLocale: async () => ({ locale: 'pt-PT' }) },
    enqueuePluginJob: async () => undefined,
    sendText: async (...args) => { sends.push(args); return { messageId: 'fixture-delivered' }; } };
}
function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wabs-poll-rollback-')); }
function cleanup(root) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('wabs-poll-rollback-'));
  fs.rmSync(root, { recursive: true, force: true });
}

test('reader rollout creates legacy-compatible announcements and does not add new configuration fields', async () => {
  const root = directory(); let db;
  try {
    db = open(path.join(root, 'polls.sqlite'));
    for (const file of migrations) db.exec(fs.readFileSync(path.join('migrations/polls', file), 'utf8'));
    seed(db, 'legacy-producer');
    const saved = previous.manifest.configSchema.parse({ maxActivePollsPerChat: 7, timezone: 'Europe/Lisbon' });
    assert.equal(Object.hasOwn(saved, 'messages'), false);
    assert.equal(await previousAnnouncements.ensurePollPublicationAnnouncement(context(db, saved), 'legacy-producer-round', new Date(now)), true);
    const delivery = previousStore.getPollDelivery(db, 'poll-announcement:legacy-producer-round:published');
    assert.deepEqual(delivery.mentionedWids ?? [], []);
    assert.equal(db.get('SELECT activation_announcement_suppressed_at AS marker FROM poll_rounds').marker, null);
    const snapshot = previousStore.getPollLifecycleByRoundId(db, 'legacy-producer-round');
    assert.equal(delivery.text, renderLegacyPublicationAnnouncement(snapshot, 'Europe/Lisbon', 'pt-PT', t));
  } finally { db?.close(); cleanup(root); }
});

test('0.4.1 to signed 0.5.0 to 0.4.1 preserves and delivers newly accepted frozen writes after restart', async () => {
  const root = directory(); let db;
  try {
    assert.equal(previous.manifest.version, '0.4.1');
    assert.equal(forward.manifest.version, '0.5.0');
    const file = path.join(root, 'polls.sqlite');
    db = open(file);
    for (const migration of migrations.slice(0,5)) db.exec(fs.readFileSync(path.join('migrations/polls', migration), 'utf8'));
    seed(db, 'accepted-poll');
    const definition = db.get('SELECT definition_json FROM polls').definition_json;
    for (const migration of migrations.slice(5)) db.exec(fs.readFileSync(path.join('migrations/polls', migration), 'utf8'));
    const savedConfig = { timezone: 'Europe/Lisbon', messages: { result: 'Accepted layout: {question}', mentionEligible: true, activationEnabled: false } };
    const newConfig = forward.manifest.configSchema.parse(savedConfig);
    const publicationId = 'poll-announcement:accepted-poll-round:published';
    const pending = forwardStore.ensurePollLifecycleDelivery(db, { pollId: 'accepted-poll', roundId: 'accepted-poll-round', createdAt: now,
      activationAnnouncementEnabled: false, reuseExistingAnnouncement: true,
      delivery: { id: publicationId, kind: 'announcement', deliveryKey: 'accepted-key', chatId: 'fixture@g.us', text: 'Frozen text from 0.5.0',
        mentionedWids: ['one@c.us', 'two@c.us', 'one@c.us'], idempotencyKey: 'accepted-idempotency' } });
    const frozenMarker = db.get('SELECT activation_announcement_suppressed_at AS marker FROM poll_rounds').marker;
    assert.ok(frozenMarker);
    db.close(); db = open(file);
    assert.equal(db.get('SELECT definition_json FROM polls').definition_json, definition);
    const restoredConfig = previous.manifest.configSchema.parse(newConfig);
    assert.deepEqual(restoredConfig.messages, newConfig.messages);
    assert.equal(previousStore.getPollDelivery(db, publicationId).text, pending.text);
    assert.deepEqual(previousStore.getPollDelivery(db, publicationId).mentionedWids, ['one@c.us', 'two@c.us']);
    assert.deepEqual(previousStore.listPollRoundIdsMissingAnnouncements(db), []);
    const sends = [];
    await deliverPollMessage(context(db, restoredConfig, sends), publicationId, () => new Date('2026-09-12T10:01:00Z'));
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0], ['fixture@g.us', pending.text, { idempotencyKey: 'accepted-idempotency', mentionedWids: ['one@c.us', 'two@c.us'], requiredProviderId: 'whatsmeow' }]);
    assert.equal(previousStore.getPollDelivery(db, publicationId).status, 'sent');
    assert.equal(previousStore.getPollDelivery(db, publicationId).messageId, 'fixture-delivered');
    assert.equal(db.get('SELECT activation_announcement_suppressed_at AS marker FROM poll_rounds').marker, frozenMarker);
    assert.equal(previousStore.getPollAggregate(db, 'accepted-poll').rounds[0].closesAt, cutoff);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally { db?.close(); cleanup(root); }
});
