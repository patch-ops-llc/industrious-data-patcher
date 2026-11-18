import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { channelStatus, createAlerter, createRunNotifier, sendTestAlert } from '../src/alerts.js';
import { assertValidMapping, ConfigError, loadMapping, loadSettings, mappingProblems, normalizeMapping, parseEmailList } from '../src/config.js';
import { migrate, migrationFiles, openDatabase } from '../src/db/index.js';
import { getAlertSettings, getAlertState, saveAlertSettings } from '../src/db/store.js';
import { objectsToIngest } from '../src/engine/ingest.js';
import { startScheduler } from '../src/scheduler.js';
import { makeTestDb } from './db.js';
import { makeHarness, SHIPPED_MAPPING_FILE, TEST_MAPPING_FILE } from './helpers.js';

const fixture = () => JSON.parse(fs.readFileSync(TEST_MAPPING_FILE, 'utf8'));

test('settings: dry run is the default and only an explicit false turns it off', () => {
  assert.equal(loadSettings({}).dryRun, true);
  assert.equal(loadSettings({ DRY_RUN: '' }).dryRun, true);
  assert.equal(loadSettings({ DRY_RUN: 'true' }).dryRun, true);
  assert.equal(loadSettings({ DRY_RUN: 'false' }).dryRun, false);
  assert.throws(() => loadSettings({ DRY_RUN: 'maybe' }), ConfigError);
});

test('settings: defaults, overrides and validation', () => {
  const defaults = loadSettings({});
  assert.equal(defaults.hubspotBaseUrl, 'https://api.hubapi.com');
  assert.equal(defaults.hubspotApiVersion, '2026-09');
  assert.equal(defaults.runIntervalMinutes, 30);
  assert.equal(defaults.hubspotToken, '');
  assert.match(defaults.mappingFile, /config\/mapping\.json$/);

  assert.equal(defaults.databaseUrl, '');
  assert.equal(defaults.databaseSsl, 'disable');
  assert.equal(defaults.fullRefreshHours, 24);
  assert.equal(defaults.changeOverlapMinutes, 5);
  assert.equal(defaults.keepRunsDays, 90);
  assert.equal(defaults.runLockStaleMinutes, 15);
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.adminPassword, '');
  assert.equal(defaults.adminSessionHours, 12);
  assert.equal(defaults.adminInsecureCookie, false);
  assert.deepEqual(defaults.alerts, { slackWebhookUrl: '', emailTo: [], emailFrom: '', resendApiKey: '', resendApiBase: 'https://api.resend.com', minRepeatMinutes: 60 });

  const custom = loadSettings({
    RUN_INTERVAL_MINUTES: '15',
    HUBSPOT_API_VERSION: 'legacy',
    DATABASE_URL: 'postgres://u:p@host/db',
    DATABASE_SSL: 'require',
    ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
    ALERT_EMAIL_TO: 'a@example.com; b@example.com',
    ALERT_EMAIL_FROM: ' alerts@example.com ',
    RESEND_API_KEY: 're_x',
    HUBSPOT_PRIVATE_APP_TOKEN: 'abc',
    PORT: '8080',
    ADMIN_PASSWORD: 'a long enough password',
  });
  assert.equal(custom.runIntervalMinutes, 15);
  assert.equal(custom.hubspotApiVersion, 'legacy');
  assert.equal(custom.databaseUrl, 'postgres://u:p@host/db');
  assert.equal(custom.databaseSsl, 'require');
  assert.equal(custom.alerts.slackWebhookUrl, 'https://hooks.slack.test/x');
  assert.deepEqual(custom.alerts.emailTo, ['a@example.com', 'b@example.com']);
  assert.equal(custom.alerts.emailFrom, 'alerts@example.com');
  assert.equal(custom.alerts.resendApiKey, 're_x');
  assert.equal(custom.hubspotToken, 'abc');
  assert.equal(custom.port, 8080);

  assert.throws(() => loadSettings({ RUN_INTERVAL_MINUTES: '0' }), ConfigError);
  assert.throws(() => loadSettings({ RUN_INTERVAL_MINUTES: 'soon' }), ConfigError);
  assert.throws(() => loadSettings({ HUBSPOT_API_VERSION: 'v3' }), ConfigError);
  assert.throws(() => loadSettings({ DATABASE_SSL: 'maybe' }), ConfigError);
  assert.throws(() => loadSettings({ ALERT_EMAIL_TO: 'not-an-address' }), ConfigError);
  assert.throws(() => loadSettings({ RUN_LOCK_STALE_MINUTES: '1' }), ConfigError);

  // The settings the state file and SMTP used are gone.
  const old = loadSettings({ STATE_DIR: '/data', SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'x', FIRST_RUN_LOOKBACK_HOURS: '1' });
  assert.ok(!/smtp|stateDir|lookback/i.test(JSON.stringify(old)));
});

test('settings: email lists accept commas, semicolons, spaces and new lines, drop repeats, and report what is not an address', () => {
  assert.deepEqual(parseEmailList('a@example.com, B@example.com;c@example.com\n a@EXAMPLE.com'), { addresses: ['a@example.com', 'B@example.com', 'c@example.com'], invalid: [] });
  assert.deepEqual(parseEmailList(''), { addresses: [], invalid: [] });
  assert.deepEqual(parseEmailList(undefined), { addresses: [], invalid: [] });
  assert.deepEqual(parseEmailList('a@example.com nope <x@example.com> a@b').invalid, ['nope', '<x@example.com>', 'a@b']);
});

test('settings: no Epicor or Jitterbit connection setting exists', () => {
  const settings = loadSettings({ EPICOR_URL: 'https://epicor.example', EPICOR_API_KEY: 'x', JITTERBIT_URL: 'https://jb.example' });
  assert.ok(!/epicor|jitterbit/i.test(JSON.stringify(settings)));
});

test('mapping: placeholders in an enabled part are reported; disabled parts may keep theirs', () => {
  const raw = fixture();
  raw.objects.quoteHeader.properties.quoteContactNumber = 'REPLACE_ME: not known yet';
  raw.rules.find((r) => r.id === 'header_to_company').association.typeId = 'REPLACE_ME: type id';
  const problems = mappingProblems(normalizeMapping(raw));
  assert.deepEqual(problems.sort(), [
    'objects.quoteHeader.properties.quoteContactNumber is not filled in',
    'rules.header_to_company.association.typeId is not filled in',
  ]);

  raw.rules.find((r) => r.id === 'contacts_to_header').enabled = false;
  raw.rules.find((r) => r.id === 'header_to_company').enabled = false;
  const mapping = normalizeMapping(raw);
  assert.deepEqual(mappingProblems(mapping), []);
  assert.ok(!objectsToIngest(mapping).includes('contact'));
  assert.deepEqual(mappingProblems(mapping, { forCleanup: true }), ['objects.quoteHeader.properties.quoteContactNumber is not filled in']);
});

test('mapping: structural mistakes are reported in plain words', () => {
  const raw = fixture();
  raw.rules[0].match = [];
  raw.rules[1].association = { category: 'SOMETHING', typeId: 1.5 };
  raw.rules[2].onMultipleTargets = 'guess';
  raw.rules[3].ifAssociatedElsewhere = 'replace';
  raw.rules[4].to = 'nowhere';
  raw.rules.push({ ...raw.rules[0], match: [{ from: 'quoteNumber', to: 'quoteNumber' }] });
  raw.dealAmount.trigger = 'always';
  raw.dealAmount.amountDependsOnRule = 'header_to_deal';
  raw.dealAmount.backlogLinkedLines = 'sometimes';
  raw.dealAmount.backfillInFullRun = 'false';
  raw.dealAmount.requireOneToOne = 'yes';
  const problems = mappingProblems(normalizeMapping(raw)).join('\n');
  assert.match(problems, /rules\.lines_to_header\.match must list at least one/);
  assert.match(problems, /association\.category must be one of/);
  assert.match(problems, /association\.typeId must be an integer/);
  assert.match(problems, /onMultipleTargets must be one of/);
  assert.match(problems, /ifAssociatedElsewhere must be "add" or "skip"/);
  assert.match(problems, /object "nowhere" is not defined/);
  assert.match(problems, /rule id "lines_to_header" is used more than once/);
  assert.match(problems, /dealAmount\.trigger must be one of/);
  assert.match(problems, /amountDependsOnRule must be a rule that associates records to the quote header/);
  assert.match(problems, /dealAmount\.backlogLinkedLines must be one of record_only, update_deals/);
  assert.match(problems, /dealAmount\.backfillInFullRun must be true or false/);
  assert.match(problems, /dealAmount\.requireOneToOne must be true or false/);
  assert.throws(() => assertValidMapping(normalizeMapping(raw)), ConfigError);
});

test('mapping: unreadable or invalid files give a configuration error', () => {
  assert.throws(() => loadMapping('/no/such/mapping.json'), ConfigError);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-'));
  const file = path.join(dir, 'mapping.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadMapping(file), /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mapping: the standard Contact part of the cleanup is off unless switched on, and is checked when it is', () => {
  const shipped = loadMapping(SHIPPED_MAPPING_FILE);
  assert.equal(shipped.contactCleanup.standardContacts.enabled, false);
  assert.equal(shipped.dealAmount.backlogLinkedLines, 'update_deals');
  // Closed deals are never changed, and a deal amount only follows a quote that gained a new line.
  assert.equal(shipped.dealAmount.skipClosedDeals, true);
  assert.equal(shipped.dealAmount.requireNewLines, true);
  assert.equal(shipped.dealAmount.requireOneToOne, true);
  // The catch-up of existing amount mismatches is its own setting and is off.
  assert.equal(shipped.dealAmount.backfillInFullRun, false);
  assert.equal(shipped.dealAmount.trigger, 'header_amount_changed');
  assert.deepEqual(mappingProblems(shipped), []);
  // Item B2 stays off until its two property names exist.
  assert.equal(shipped.rules.find((r) => r.id === 'contacts_to_header').enabled, false);
  assert.deepEqual(mappingProblems(shipped, { forCleanup: true }).sort(), [
    'objects.contact.properties.customerContactNumber is not filled in',
    'objects.quoteHeader.properties.quoteContactNumber is not filled in',
  ]);
  // The quote-number rule comes after the deal-ID rule and never links on a repeated number.
  const ids = shipped.rules.map((r) => r.id);
  assert.ok(ids.indexOf('header_to_deal_by_quote_number') === ids.indexOf('header_to_deal') + 1);
  const byNumber = shipped.rules.find((r) => r.id === 'header_to_deal_by_quote_number');
  assert.equal(byNumber.enabled, true);
  assert.equal(byNumber.onMultipleTargets, 'skip');
  // A quote that already has a different deal also gets the deal carrying its number.
  assert.equal(byNumber.ifAssociatedElsewhere, 'add');
  // A mapping that leaves the settings out gets the same behaviour.
  const bare = fixture();
  delete bare.dealAmount.backlogLinkedLines;
  delete bare.dealAmount.backfillInFullRun;
  assert.equal(normalizeMapping(bare).dealAmount.backlogLinkedLines, 'update_deals');
  assert.equal(normalizeMapping(bare).dealAmount.backfillInFullRun, false);

  // A mapping without the block gets it, switched off.
  const raw = fixture();
  delete raw.contactCleanup;
  assert.equal(normalizeMapping(raw).contactCleanup.standardContacts.enabled, false);

  const on = fixture();
  on.contactCleanup.standardContacts = { enabled: true };
  assert.match(mappingProblems(normalizeMapping(on), { forCleanup: true }).join('\n'), /object "standardContact" is not defined/);
  on.contactCleanup.standardContacts = { enabled: 'yes' };
  assert.match(mappingProblems(normalizeMapping(on), { forCleanup: true }).join('\n'), /standardContacts\.enabled must be true or false/);
  on.contactCleanup.standardContacts = { enabled: true, object: 'contact' };
  assert.match(mappingProblems(normalizeMapping(on), { forCleanup: true }).join('\n'), /must be the standard Contact object/);
  // Same HubSpot object under another name: still refused (the fixture's B2 contact is the standard Contact object).
  on.objects.standardContact = { objectType: 'contacts', properties: {} };
  on.contactCleanup.standardContacts = { enabled: true };
  assert.match(mappingProblems(normalizeMapping(on), { forCleanup: true }).join('\n'), /must be the standard Contact object/);
  on.objects.contact.objectType = '2-999';
  assert.deepEqual(mappingProblems(normalizeMapping(on), { forCleanup: true }), []);
  on.contactCleanup.standardContacts = { enabled: true, keepLinkedToNamedContact: 'no', removeOnlyTypeIds: [] };
  const problems = mappingProblems(normalizeMapping(on), { forCleanup: true }).join('\n');
  assert.match(problems, /keepLinkedToNamedContact must be true or false/);
  assert.match(problems, /standardContacts\.removeOnlyTypeIds must be null or a non-empty list/);
});

test('staging database: migrations create every table once, are safe to repeat, and a failing migration leaves nothing behind', async () => {
  const db = await makeTestDb({ migrated: false });
  const applied = await migrate(db);
  assert.deepEqual(applied, migrationFiles());
  assert.ok(applied.length >= 1 && applied.every((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)));
  assert.deepEqual(await migrate(db), []);

  const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1`)).rows.map((r) => r.table_name);
  assert.deepEqual(tables, [
    'admin_password', 'alert_settings', 'alert_state', 'association_actions', 'contact_cleanup_removals', 'deal_amount_baselines', 'deal_amount_holds', 'ingest_cursors',
    'review_items', 'run_lock', 'runs', 'schedule_settings', 'schema_migrations', 'staging_associations', 'staging_records',
  ]);
  // The columns behind "only when the quote gained a new line" (migration 003).
  const added = (await db.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name IN ('new_lines_until', 'arrivals_since') ORDER BY 1`,
  )).rows.map((r) => [r.table_name, r.column_name, r.data_type]);
  assert.deepEqual(added, [
    ['deal_amount_baselines', 'new_lines_until', 'timestamp with time zone'],
    ['ingest_cursors', 'arrivals_since', 'timestamp with time zone'],
  ]);
  assert.ok(applied.includes('003_deal_amount_new_lines.sql'));
  // Laid out for Option C: a record can come from a source other than HubSpot and have no HubSpot ID yet.
  const columns = (await db.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'staging_records'`)).rows;
  const column = (name) => columns.find((c) => c.column_name === name);
  assert.equal(column('hubspot_id').is_nullable, 'YES');
  assert.equal(column('source').is_nullable, 'NO');
  assert.ok(column('source_record_id'));
  assert.ok(column('properties'));
  await db.query(`INSERT INTO staging_records (object_key, hubspot_object_type, source, source_record_id, properties) VALUES ('quoteHeader', '2-1', 'jitterbit', 'Q-1', '{"quote_number":"1"}'::jsonb)`);
  assert.equal((await db.query(`SELECT source FROM staging_records WHERE hubspot_id IS NULL`)).rows[0].source, 'jitterbit');

  // The single-row tables refuse a second row.
  await assert.rejects(db.query(`INSERT INTO alert_settings (id, enabled, email_recipients, repeat_minutes) VALUES (2, true, '[]'::jsonb, 60)`));
  await assert.rejects(db.query(`INSERT INTO run_lock (id, holder, taken_at) VALUES (2, 'x', now())`));
  await assert.rejects(db.query(`INSERT INTO admin_password (id, password_hash, variable_hash, changed_at) VALUES (2, 'x', 'y', now())`));
  // The admin password table (migration 004) starts empty: the ADMIN_PASSWORD variable is the password until it is changed on the page.
  assert.ok(applied.includes('004_admin_password.sql'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM admin_password')).rows[0].n, 0);
  // The schedule table (migration 005) starts empty too: RUN_INTERVAL_MINUTES applies until the schedule is saved on the admin page.
  assert.ok(applied.includes('005_schedule_settings.sql'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM schedule_settings')).rows[0].n, 0);
  await assert.rejects(db.query(`INSERT INTO schedule_settings (id, enabled, interval_minutes, updated_at) VALUES (2, true, 30, now())`));
  await assert.rejects(db.query(`INSERT INTO schedule_settings (id, enabled, interval_minutes, updated_at) VALUES (1, true, 0, now())`));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE extra_one (id int);');
  fs.writeFileSync(path.join(dir, '002_broken.sql'), 'CREATE TABLE extra_two (id int); SELECT * FROM no_such_table;');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a migration');
  await assert.rejects(migrate(db, { dir }));
  const after = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'extra_%'`)).rows.map((r) => r.table_name);
  assert.deepEqual(after, ['extra_one']);
  assert.deepEqual((await db.query(`SELECT name FROM schema_migrations WHERE name LIKE '00%ok.sql' OR name LIKE '%broken%'`)).rows.map((r) => r.name), ['001_ok.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
  await db.close();

  await assert.rejects(openDatabase(''), /DATABASE_URL is not set/);
});

const failedRun = { runId: 'r1', mode: 'incremental', dryRun: false, status: 'failed', error: 'HubSpot is down', rules: [] };
const okRun = { runId: 'r2', mode: 'incremental', dryRun: false, status: 'ok', rules: [] };
const partialRun = { runId: 'r3', mode: 'incremental', dryRun: false, status: 'completed_with_errors', rules: [] };

const RESEND = { resendApiKey: 're_test_key', emailFrom: 'Industrious cleanup <alerts@patchops.example>', resendApiBase: 'https://api.resend.test' };

test('alerts: email goes through the Resend API and Slack through the webhook; a broken channel does not throw or stop the other', async () => {
  const calls = [];
  const alerter = createAlerter(
    { ...RESEND, slackWebhookUrl: 'https://hooks.slack.test/T/B/x' },
    { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'e1' }), { status: 200 }); } },
  );
  const result = await alerter.send({ subject: 'run FAILED', lines: ['Error: HubSpot is down', 'second line'] }, { recipients: ['ops@example.com', 'zach@example.com'] });
  assert.deepEqual(result, { email: 'sent', slack: 'sent' });

  const email = calls.find((c) => c.url === 'https://api.resend.test/emails');
  assert.equal(email.init.method, 'POST');
  assert.equal(email.init.headers.authorization, 'Bearer re_test_key');
  assert.equal(email.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(email.init.body), {
    from: 'Industrious cleanup <alerts@patchops.example>',
    to: ['ops@example.com', 'zach@example.com'],
    subject: 'run FAILED',
    text: 'Error: HubSpot is down\nsecond line',
  });
  assert.ok(email.init.signal, 'the request has a timeout');
  const slack = calls.find((c) => c.url === 'https://hooks.slack.test/T/B/x');
  assert.match(JSON.parse(slack.init.body).text, /\*run FAILED\*\nError: HubSpot is down/);
  assert.ok(!slack.init.body.includes('re_test_key'));

  // Resend rejects the request: its message is reported, Slack still goes out.
  const half = createAlerter(
    { ...RESEND, slackWebhookUrl: 'https://hooks.slack.test/x' },
    {
      fetchImpl: async (url) => (String(url).includes('resend')
        ? new Response(JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' }), { status: 422 })
        : new Response('ok', { status: 200 })),
    },
  );
  assert.deepEqual(await half.send({ subject: 's', lines: [] }, { recipients: ['ops@example.com'] }), { email: 'failed: Resend returned 422: Invalid `from` field.', slack: 'sent' });

  const down = createAlerter({ ...RESEND, slackWebhookUrl: 'https://hooks.slack.test/x' }, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.deepEqual(await down.send({ subject: 's', lines: [] }, { recipients: ['ops@example.com'] }), { email: 'failed: getaddrinfo ENOTFOUND', slack: 'failed: getaddrinfo ENOTFOUND' });
  const slow = createAlerter({ ...RESEND }, { fetchImpl: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
  assert.deepEqual(await slow.send({ subject: 's', lines: [] }, { recipients: ['ops@example.com'] }), { email: 'failed: timed out' });
  const badSlack = createAlerter({ slackWebhookUrl: 'https://hooks.slack.test/x' }, { fetchImpl: async () => new Response('no', { status: 500 }) });
  assert.deepEqual(await badSlack.send({ subject: 's', lines: [] }), { slack: 'failed: Slack webhook returned 500' });
});

test('alerts: email needs the Resend key, a from address and at least one recipient; nothing configured sends nothing', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  assert.deepEqual(channelStatus({}, ['a@example.com']), { slack: false, emailConfigured: false, email: false });
  assert.deepEqual(channelStatus({ resendApiKey: 'k' }, ['a@example.com']), { slack: false, emailConfigured: false, email: false });
  assert.deepEqual(channelStatus({ ...RESEND }, []), { slack: false, emailConfigured: true, email: false });
  assert.deepEqual(channelStatus({ ...RESEND, slackWebhookUrl: 'https://x' }, ['a@example.com']), { slack: true, emailConfigured: true, email: true });

  assert.deepEqual(await createAlerter({}, { fetchImpl }).send({ subject: 's', lines: [] }, { recipients: ['a@example.com'] }), {});
  assert.deepEqual(await createAlerter({ ...RESEND }, { fetchImpl }).send({ subject: 's', lines: [] }, { recipients: [] }), {});
  assert.deepEqual(await createAlerter({ emailFrom: 'a@example.com' }, { fetchImpl }).send({ subject: 's', lines: [] }, { recipients: ['a@example.com'] }), {});
  assert.equal(calls, 0);
});

function recordingAlerter() {
  const sent = [];
  return { sent, send: async (message, options) => { sent.push({ subject: message.subject, recipients: options.recipients }); return { email: 'sent' }; } };
}

test('alerts: the first failure alerts, repeats are held back, recovery is announced once, and the state survives a restart', async () => {
  const h = await makeHarness();
  await saveAlertSettings(h.db, { enabled: true, emailRecipients: ['ops@example.com'], repeatMinutes: 60, now: new Date() });
  const alerter = recordingAlerter();
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const make = () => createRunNotifier({ db: h.db, alerter, now: () => new Date(clock) });
  let notifier = make();

  assert.equal(await notifier.afterRun(okRun), null);
  assert.equal(alerter.sent.length, 0);
  assert.deepEqual(await notifier.afterRun(failedRun), { email: 'sent' });
  assert.match(alerter.sent[0].subject, /^Industrious association cleanup: run FAILED$/);
  assert.deepEqual(alerter.sent[0].recipients, ['ops@example.com']);
  let state = await getAlertState(h.db);
  assert.equal(state.failing, true);
  assert.equal(new Date(state.lastAlertAt).getTime(), clock);
  assert.equal(state.lastSubject, 'Industrious association cleanup: run FAILED');
  assert.deepEqual(state.lastResult, { email: 'sent' });

  // The service restarts while runs are still failing: no second alert.
  notifier = make();
  clock += 30 * 60_000;
  await notifier.afterRun(failedRun);
  await notifier.afterRun({ ...failedRun, status: 'skipped' });
  assert.equal(alerter.sent.length, 1);

  clock += 31 * 60_000;
  await notifier.afterRun({ ...partialRun, dryRun: true });
  assert.match(alerter.sent[1].subject, /run completed with errors \(dry run\)$/);

  notifier = make();
  await notifier.afterRun(okRun);
  assert.match(alerter.sent[2].subject, /recovered$/);
  await notifier.afterRun(okRun);
  assert.equal(alerter.sent.length, 3);
  state = await getAlertState(h.db);
  assert.equal(state.failing, false);
  assert.equal(state.lastAlertAt, null);
  await h.cleanup();
});

test('alerts: the on/off switch, recipients and repeat interval saved in the staging database are used on the next run', async () => {
  const h = await makeHarness();
  const alerter = recordingAlerter();
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const notifier = createRunNotifier({ db: h.db, alerter, now: () => new Date(clock), defaults: { emailTo: ['env@example.com'], minRepeatMinutes: 60 } });

  // Switched off: nothing is sent, but the failing state is still tracked.
  await saveAlertSettings(h.db, { enabled: false, emailRecipients: ['ops@example.com'], repeatMinutes: 60, now: new Date() });
  assert.equal(await notifier.afterRun(failedRun), null);
  assert.equal(alerter.sent.length, 0);
  assert.equal((await getAlertState(h.db)).failing, true);

  // Switched on while runs are failing: the next failing run alerts, to the new recipients.
  await saveAlertSettings(h.db, { enabled: true, emailRecipients: ['new@example.com'], repeatMinutes: 10, now: new Date() });
  clock += 60_000;
  await notifier.afterRun(failedRun);
  assert.deepEqual(alerter.sent.map((s) => s.recipients), [['new@example.com']]);

  // Repeat interval of 10 minutes.
  clock += 9 * 60_000;
  await notifier.afterRun(failedRun);
  assert.equal(alerter.sent.length, 1);
  clock += 60_000;
  await notifier.afterRun(failedRun);
  assert.equal(alerter.sent.length, 2);

  // 0 = alert on every failing run.
  await saveAlertSettings(h.db, { enabled: true, emailRecipients: ['new@example.com'], repeatMinutes: 0, now: new Date() });
  await notifier.afterRun(failedRun);
  await notifier.afterRun(failedRun);
  assert.equal(alerter.sent.length, 4);

  // Switched off before recovery: no recovery message, and none later for a failure nobody was told about.
  await saveAlertSettings(h.db, { enabled: false, emailRecipients: ['new@example.com'], repeatMinutes: 0, now: new Date() });
  await notifier.afterRun(okRun);
  await saveAlertSettings(h.db, { enabled: true, emailRecipients: ['new@example.com'], repeatMinutes: 0, now: new Date() });
  await notifier.afterRun(okRun);
  assert.equal(alerter.sent.length, 4);
  assert.deepEqual((await getAlertSettings(h.db)).emailRecipients, ['new@example.com']);
  await h.cleanup();
});

test('alerts: when the staging database cannot be read, the failure is still reported using the service variables', async () => {
  const alerter = recordingAlerter();
  const warnings = [];
  let clock = 0;
  const brokenDb = { query: async () => { throw new Error('connect ECONNREFUSED'); } };
  const notifier = createRunNotifier({
    db: brokenDb,
    alerter,
    now: () => new Date(clock),
    defaults: { emailTo: ['env@example.com'], minRepeatMinutes: 60 },
    logger: { warn: (msg) => warnings.push(msg) },
  });
  assert.deepEqual(await notifier.afterRun({ ...failedRun, error: 'connect ECONNREFUSED' }), { email: 'sent' });
  assert.deepEqual(alerter.sent[0].recipients, ['env@example.com']);
  assert.match(warnings[0], /could not be read from the staging database/);
  // Held back in memory while the database stays down.
  clock += 5 * 60_000;
  await notifier.afterRun(failedRun);
  assert.equal(alerter.sent.length, 1);
  clock += 60 * 60_000;
  await notifier.afterRun(failedRun);
  assert.equal(alerter.sent.length, 2);
});

test('alerts: a test alert goes out even when alerts are switched off and does not change the failing state', async () => {
  const h = await makeHarness();
  await saveAlertSettings(h.db, { enabled: false, emailRecipients: ['ops@example.com'], repeatMinutes: 60, now: new Date() });
  const sent = [];
  const alerter = { send: async (message, options) => { sent.push({ message, options }); return { email: 'sent' }; } };
  const at = new Date('2026-11-12T10:00:00Z');
  assert.deepEqual(await sendTestAlert({ db: h.db, alerter, now: () => at }), { email: 'sent' });
  assert.equal(sent[0].message.subject, 'Industrious association cleanup: test alert');
  assert.deepEqual(sent[0].options.recipients, ['ops@example.com']);
  assert.match(sent[0].message.lines.join('\n'), /Nothing is wrong/);
  const state = await getAlertState(h.db);
  assert.equal(state.failing, false);
  assert.equal(state.lastAlertAt, null);
  assert.equal(new Date(state.lastSentAt).getTime(), at.getTime());
  await h.cleanup();
});

test('scheduler: runs start a fixed interval apart, never overlap, survive a throwing run, and stop cleanly', async () => {
  const timers = [];
  const starts = [];
  let active = 0;
  let maxActive = 0;
  let release;
  const scheduler = startScheduler({
    intervalMs: 1000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    task: async () => {
      starts.push(Date.now());
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => { release = resolve; });
      active -= 1;
      if (starts.length === 2) throw new Error('boom');
    },
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(starts.length, 1);
  assert.equal(timers.length, 0, 'no timer while a run is in progress');
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms <= 1000 && timers[0].ms >= 900);

  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(starts.length, 2);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 2, 'a run that throws does not stop the schedule');

  timers[1].fn();
  await new Promise((r) => setImmediate(r));
  const stopping = scheduler.stop();
  release();
  await stopping;
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 2, 'nothing is scheduled after stop');
  assert.equal(maxActive, 1);
});

test('scheduler: a run can be started by hand, the schedule can be paused and its interval changed, and runs still never overlap', async () => {
  const timers = [];
  const cleared = [];
  const triggers = [];
  let clock = 1_000_000;
  let release;
  let active = 0;
  let maxActive = 0;
  const next = () => new Promise((r) => setImmediate(r));
  const scheduler = startScheduler({
    intervalMs: 60_000,
    enabled: false,
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { cleared.push(id); },
    task: async ({ trigger }) => {
      triggers.push(trigger);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => { release = resolve; });
      active -= 1;
    },
  });

  // Paused from the start: nothing runs and nothing is planned.
  await next();
  assert.deepEqual(triggers, []);
  assert.equal(timers.length, 0);
  assert.deepEqual(scheduler.status(), { enabled: false, intervalMs: 60_000, running: false, runningSince: null, runningTrigger: null, nextRunAt: null, lastStartedAt: null });

  // A run by hand works while paused, one at a time.
  assert.deepEqual(scheduler.runNow(), { started: true });
  assert.deepEqual(scheduler.runNow(), { started: false, reason: 'running' });
  assert.deepEqual(triggers, ['manual']);
  assert.deepEqual(scheduler.status(), { enabled: false, intervalMs: 60_000, running: true, runningSince: 1_000_000, runningTrigger: 'manual', nextRunAt: null, lastStartedAt: 1_000_000 });
  clock += 5_000;
  release();
  await next();
  assert.equal(scheduler.status().running, false);
  assert.equal(timers.length, 0, 'still paused after a run by hand');

  // Switched on: the next run is one interval after the last run started.
  clock += 5_000;
  scheduler.setSchedule({ enabled: true, intervalMs: 60_000 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 50_000);
  assert.equal(scheduler.status().nextRunAt, 1_060_000);

  // A longer interval moves the planned run; a shorter one that is already due runs at once.
  scheduler.setSchedule({ enabled: true, intervalMs: 120_000 });
  assert.deepEqual(cleared, [1]);
  assert.equal(timers[1].ms, 110_000);
  scheduler.setSchedule({ enabled: true, intervalMs: 5_000 });
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(timers[2].ms, 0);

  // A run by hand takes the place of the planned one and restarts the count.
  scheduler.setSchedule({ enabled: true, intervalMs: 60_000 });
  clock += 20_000;
  assert.deepEqual(scheduler.runNow(), { started: true });
  assert.deepEqual(cleared, [1, 2, 3, 4]);
  // A change made during a run waits for the run to finish.
  scheduler.setSchedule({ enabled: true, intervalMs: 90_000 });
  assert.equal(timers.length, 4);
  clock += 10_000;
  release();
  await next();
  assert.equal(timers.length, 5);
  assert.equal(timers[4].ms, 80_000);

  // The timer starts a scheduled run; a run by hand is refused meanwhile.
  clock += 80_000;
  timers[4].fn();
  assert.deepEqual(triggers, ['manual', 'manual', 'schedule']);
  assert.equal(scheduler.status().runningTrigger, 'schedule');
  assert.deepEqual(scheduler.runNow(), { started: false, reason: 'running' });
  // Paused during a run: the run finishes, and no other is planned.
  scheduler.setSchedule({ enabled: false, intervalMs: 90_000 });
  release();
  await next();
  assert.equal(timers.length, 5);
  assert.equal(scheduler.status().nextRunAt, null);

  // After stop nothing starts any more.
  scheduler.setSchedule({ enabled: true, intervalMs: 90_000 });
  assert.equal(timers.length, 6);
  await scheduler.stop();
  assert.deepEqual(scheduler.runNow(), { started: false, reason: 'stopping' });
  scheduler.setSchedule({ enabled: true, intervalMs: 1_000 });
  assert.equal(timers.length, 6);
  assert.equal(maxActive, 1);
  assert.deepEqual(triggers, ['manual', 'manual', 'schedule']);
});
