import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/index.js';
import { FakeHubSpot } from './fake-hubspot.js';
import { P, seedPortalSchema, SHIPPED_MAPPING_FILE } from './helpers.js';

// End to end: the real command line in its own process, a stand-in HubSpot
// over HTTP, and a staging database (an embedded one in a temporary folder,
// or a real Postgres server when TEST_DATABASE_URL is set).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const TOKEN = 'test-token-CLI-SECRET';

function startCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    // Start from a clean environment so nothing from the machine leaks in.
    env: { PATH: process.env.PATH, ...env },
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout: out.stdout, stderr: out.stderr }));
  });
  return { child, out, done };
}

const runCli = (args, env) => startCli(args, env).done;

async function waitFor(check, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function withFakePortal(fn) {
  const fake = new FakeHubSpot({ token: TOKEN, startAt: new Date(Date.now() - 3_600_000).toISOString() });
  seedPortalSchema(fake);
  const server = await fake.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assoc-cleanup-cli-'));
  let databaseUrl = `pglite:${path.join(dir, 'staging')}`;
  let dropSchema = async () => {};
  if (process.env.TEST_DATABASE_URL) {
    const schema = `cli_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    const admin = await openDatabase(process.env.TEST_DATABASE_URL);
    await admin.exec(`CREATE SCHEMA "${schema}"`);
    await admin.close();
    const scoped = new URL(process.env.TEST_DATABASE_URL);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = scoped.toString();
    dropSchema = async () => {
      const again = await openDatabase(process.env.TEST_DATABASE_URL);
      await again.exec(`DROP SCHEMA "${schema}" CASCADE`);
      await again.close();
    };
  }
  const env = {
    HUBSPOT_PRIVATE_APP_TOKEN: TOKEN,
    HUBSPOT_API_BASE: `http://127.0.0.1:${server.address().port}`,
    DATABASE_URL: databaseUrl,
    REPORTS_DIR: path.join(dir, 'reports'),
  };
  /** Reads from the staging database between commands. */
  async function sql(text, params) {
    const db = await openDatabase(databaseUrl);
    try {
      return (await db.query(text, params)).rows;
    } finally {
      await db.close();
    }
  }
  try {
    await fn({ fake, env, dir, sql });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await dropSchema();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedFamily(fake) {
  const company = fake.addRecord(P.company, { customer_uid: '13000', epicor_customer_id: '13000' });
  const deal = fake.addRecord(P.deal, { amount: '900' });
  const line = fake.addRecord(P.line, { quote_number: '8809127' });
  const task = fake.addRecord(P.task, { quote_id: '8809127' });
  const quote = fake.addRecord(P.quote, { quote_number: '8809127', customer_uid: '13000', shipping_customer_id: '1953', hubspot_deal_id: deal, amount: '1000' });
  return { company, deal, line, task, quote };
}

/** A local stand-in for the Resend API and a Slack webhook. */
async function alertSink() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, authorization: req.headers.authorization || null, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'stand-in' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { received, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('CLI: with the shipped mapping, every command is a dry run unless --apply is given', async () => {
  await withFakePortal(async ({ fake, env, dir, sql }) => {
    const ids = seedFamily(fake);

    // preflight needs no database.
    const preflight = await runCli(['preflight'], { ...env, DATABASE_URL: '' });
    assert.equal(preflight.code, 0, preflight.stdout + preflight.stderr);
    assert.match(preflight.stdout, /Preflight passed\./);

    const migrated = await runCli(['migrate'], { ...env, HUBSPOT_PRIVATE_APP_TOKEN: '' });
    assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);
    assert.match(migrated.stdout, /Staging database is up to date\./);
    assert.equal((await runCli(['report'], env)).code, 1, 'no run recorded yet');
    const requestsAfterPreflight = fake.requests.length;
    assert.equal((await runCli(['migrate'], env)).code, 0);
    assert.equal(fake.requests.length, requestsAfterPreflight, 'migrate and report never call HubSpot');

    const dry = await runCli(['reconcile'], env);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /DRY RUN: nothing will be changed in HubSpot/);
    assert.match(dry.stdout, /Lines to header: checked 1, would fill 1/);
    assert.equal(fake.writes.length, 0);
    assert.deepEqual(fake.associated(P.line, ids.line, P.quote), []);
    const reports = fs.readdirSync(path.join(dir, 'reports'));
    assert.ok(reports.some((f) => /^reconciliation-.*-dryrun\.md$/.test(f)), reports.join(', '));
    // A dry run fills the staging database and records itself, with planned associations only.
    assert.deepEqual(await sql(`SELECT mode, dry_run, status, state_saved FROM runs`), [{ mode: 'full', dry_run: true, status: 'ok', state_saved: false }]);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM staging_records`))[0].n, 5);
    assert.deepEqual(await sql(`SELECT DISTINCT result FROM association_actions`), [{ result: 'planned' }]);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM deal_amount_baselines`))[0].n, 0);

    const report = await runCli(['report'], { ...env, HUBSPOT_PRIVATE_APP_TOKEN: '' });
    assert.equal(report.code, 0, report.stdout + report.stderr);
    assert.match(report.stdout, /# Reconciliation report/);
    assert.match(report.stdout, /DRY RUN: nothing was changed/);

    const sample = await runCli(['run', '--limit', '1'], env);
    assert.equal(sample.code, 0, sample.stdout + sample.stderr);
    assert.equal(fake.writes.length, 0);

    // DRY_RUN=false in the environment is overridden by --dry-run.
    const forced = await runCli(['reconcile', '--dry-run'], { ...env, DRY_RUN: 'false' });
    assert.equal(forced.code, 0);
    assert.equal(fake.writes.length, 0);

    const live = await runCli(['reconcile', '--apply'], env);
    assert.equal(live.code, 0, live.stdout + live.stderr);
    assert.match(live.stdout, /LIVE: changes will be written to HubSpot/);
    assert.deepEqual(fake.associated(P.line, ids.line, P.quote), [ids.quote]);
    assert.deepEqual(fake.associated(P.task, ids.task, P.quote), [ids.quote]);
    assert.deepEqual(fake.associated(P.quote, ids.quote, P.deal), [ids.deal]);
    assert.deepEqual(fake.associated(P.quote, ids.quote, P.company), [ids.company]);
    assert.equal(fake.record(P.deal, ids.deal).properties.amount, '900', 'existing amount differences are left alone');
    assert.equal((await sql(`SELECT count(*)::int AS n FROM run_lock`))[0].n, 0);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM association_actions WHERE result = 'created'`))[0].n, 4);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM runs WHERE NOT dry_run AND state_saved`))[0].n, 1);

    const byId = await runCli(['report', (await sql(`SELECT id FROM runs WHERE NOT dry_run`))[0].id], env);
    assert.match(byId.stdout, /LIVE RUN/);
    assert.equal((await runCli(['report', 'not-a-run-id'], env)).code, 2);

    const catchUp = await runCli(['reconcile', '--apply', '--deal-amounts'], env);
    assert.equal(catchUp.code, 0, catchUp.stdout + catchUp.stderr);
    assert.equal(fake.record(P.deal, ids.deal).properties.amount, '1000');

    for (const result of [preflight, dry, sample, live, catchUp, report]) {
      assert.ok(!(result.stdout + result.stderr).includes(TOKEN), 'the token never appears in the output');
    }
    for (const file of fs.readdirSync(path.join(dir, 'reports'))) {
      assert.ok(!fs.readFileSync(path.join(dir, 'reports', file), 'utf8').includes(TOKEN));
    }
  });
});

test('CLI: the contact cleanup refuses to run while the Item B2 properties are not filled in', async () => {
  await withFakePortal(async ({ fake, env }) => {
    const result = await runCli(['cleanup-contacts', '--apply'], env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /quoteContactNumber is not filled in/);
    assert.equal(fake.requests.length, 0);
  });
});

test('CLI: the one-time contact cleanup is a dry run by default, and --restore with the run ID puts everything back', async () => {
  await withFakePortal(async ({ fake, env, dir }) => {
    const mapping = JSON.parse(fs.readFileSync(SHIPPED_MAPPING_FILE, 'utf8'));
    mapping.objects.quoteHeader.properties.quoteContactNumber = 'quote_contact_number';
    mapping.objects.contact.properties.customerContactNumber = 'contact_number';
    mapping.contactCleanup.standardContacts.enabled = true;
    const mappingFile = path.join(dir, 'mapping.json');
    fs.writeFileSync(mappingFile, JSON.stringify(mapping));
    const withMapping = { ...env, MAPPING_FILE: mappingFile };

    const quote = fake.addRecord(P.quote, { quote_number: '500', customer_uid: 'U95', shipping_customer_id: '95', quote_contact_number: '2' });
    const named = fake.addRecord(P.epicorContact, { custnum: '95', contact_number: '2' });
    const colleague = fake.addRecord(P.epicorContact, { custnum: '95', contact_number: '1' });
    const stdNamed = fake.addRecord(P.contact, { email: 'named@example.com' });
    const stdColleague = fake.addRecord(P.contact, { email: 'colleague@example.com' });
    fake.associate(P.epicorContact, named, P.contact, stdNamed, 141);
    fake.associate(P.epicorContact, colleague, P.contact, stdColleague, 141);
    for (const c of [named, colleague]) fake.associate(P.quote, quote, P.epicorContact, c, 148);
    for (const c of [stdNamed, stdColleague]) fake.associate(P.quote, quote, P.contact, c, 103);

    const dry = await runCli(['cleanup-contacts'], withMapping);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /DRY RUN: nothing will be changed in HubSpot/);
    assert.equal(fake.writes.length, 0);
    assert.doesNotMatch(dry.stdout, /To put these associations back/);

    const live = await runCli(['cleanup-contacts', '--apply'], withMapping);
    assert.equal(live.code, 0, live.stdout + live.stderr);
    assert.deepEqual(fake.associated(P.quote, quote, P.epicorContact), [named]);
    assert.deepEqual(fake.associated(P.quote, quote, P.contact), [stdNamed]);
    const runId = live.stdout.match(/cleanup-contacts --restore ([0-9a-f-]{36}) --apply/)?.[1];
    assert.ok(runId, live.stdout);

    // Without --apply the restore is a dry run too.
    const restoreDry = await runCli(['cleanup-contacts', '--restore', runId], withMapping);
    assert.equal(restoreDry.code, 0, restoreDry.stdout + restoreDry.stderr);
    assert.deepEqual(fake.associated(P.quote, quote, P.contact), [stdNamed]);

    const restored = await runCli(['cleanup-contacts', '--restore', runId, '--apply'], withMapping);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.deepEqual(fake.associated(P.quote, quote, P.epicorContact).sort(), [named, colleague].sort());
    assert.deepEqual(fake.associated(P.quote, quote, P.contact).sort(), [stdNamed, stdColleague].sort());
  });
});

test('CLI: configuration mistakes exit with code 2 and a plain message; a failing HubSpot exits with 1', async () => {
  await withFakePortal(async ({ fake, env }) => {
    const noToken = await runCli(['run'], { ...env, HUBSPOT_PRIVATE_APP_TOKEN: '' });
    assert.equal(noToken.code, 2);
    assert.match(noToken.stderr, /HUBSPOT_PRIVATE_APP_TOKEN is not set/);

    const noDatabase = await runCli(['run'], { ...env, DATABASE_URL: '' });
    assert.equal(noDatabase.code, 2);
    assert.match(noDatabase.stderr, /DATABASE_URL is not set/);
    assert.equal(fake.requests.length, 0);

    const unknown = await runCli(['explode'], env);
    assert.equal(unknown.code, 2);

    const help = await runCli(['--help'], env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--apply\s+Write changes to HubSpot/);

    const badLimit = await runCli(['run', '--limit', 'few'], env);
    assert.equal(badLimit.code, 2);

    const wrongToken = await runCli(['run'], { ...env, HUBSPOT_PRIVATE_APP_TOKEN: 'not-the-token' });
    assert.equal(wrongToken.code, 1);
    assert.match(wrongToken.stdout, /finished with status: failed/);
    assert.equal(fake.writes.length, 0);

    const unreachable = await runCli(['migrate'], { ...env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' });
    assert.equal(unreachable.code, 1);
    assert.ok(!unreachable.stderr.includes(TOKEN));
  });
});

test('CLI: the service answers the health check and the admin page, runs straight away, logs JSON lines, and stops on SIGTERM', async () => {
  await withFakePortal(async ({ fake, env, sql }) => {
    const ids = seedFamily(fake);
    const port = await freePort();
    const password = 'a long admin password';
    const service = startCli(['start', '--apply'], { ...env, RUN_INTERVAL_MINUTES: '30', PORT: String(port), ADMIN_PASSWORD: password, ALERT_EMAIL_TO: 'ops@example.com' });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitFor(async () => {
        try {
          return (await fetch(`${base}/healthz`)).status === 200;
        } catch {
          return false;
        }
      }, 'the health check');
      const home = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(home.status, 303);
      const login = await fetch(`${base}/login`);
      assert.equal(login.status, 200);
      assert.match(await login.text(), /type="password"/);
      await waitFor(() => /"msg":"run finished"/.test(service.out.stdout), 'the first run');

      const signIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
      assert.equal(signIn.status, 303);
      const cookie = signIn.headers.get('set-cookie').split(';')[0];
      const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
      assert.match(page, /<span class="badge good">OK<\/span> <span class="badge live">Live<\/span>/);
      assert.match(page, />ops@example\.com<\/textarea>/, 'ALERT_EMAIL_TO seeds the recipients the first time');
      // Link health, from the run the service just made: every record of the family is linked by its ID.
      const health = page.slice(page.indexOf('<h2>Link health</h2>'), page.indexOf('<h2>Last run</h2>'));
      for (const name of ['Epicor Quote Line Item <span class="health-to">to</span> Epicor Quote', 'Epicor Task <span class="health-to">to</span> Epicor Quote', 'Epicor Quote <span class="health-to">to</span> Deal', 'Epicor Quote <span class="health-to">to</span> Company']) {
        assert.ok(health.includes(`<p class="health-name">${name}</p>`), name);
      }
      assert.equal((health.match(/<p class="health-share good">100%<\/p>\n<p class="health-count"><strong>1<\/strong> of 1 linked<\/p>/g) || []).length, 4);
      assert.match(health, /Matched on <code>hubspot_deal_id<\/code> or <code>quote_number<\/code>\./);
      assert.ok(!page.includes(TOKEN) && !page.includes(password));
    } finally {
      service.child.kill('SIGTERM');
    }
    const result = await service.done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((l) => l.msg === 'service starting' && l.intervalMinutes === 30 && l.schedule === 'on' && l.scheduleFrom === 'RUN_INTERVAL_MINUTES variable' && l.dryRun === false && l.adminPage === 'on' && l.adminSignIn === 'ADMIN_PASSWORD variable' && l.port === port));
    assert.ok(lines.some((l) => l.msg === 'run finished' && l.status === 'ok'));
    assert.deepEqual(lines.filter((l) => l.msg === 'link health').map((l) => [l.from, l.to, l.records, l.linked]), [
      ['quoteLine', 'quoteHeader', 1, 1], ['quoteTask', 'quoteHeader', 1, 1], ['quoteHeader', 'deal', 1, 1], ['quoteHeader', 'company', 1, 1], ['icCode', 'company', 0, 0],
    ]);
    assert.ok(lines.some((l) => /shutting down/.test(l.msg)));
    assert.ok(!result.stdout.includes(TOKEN), 'the token never appears in the log');
    assert.ok(!result.stdout.includes(password));
    assert.deepEqual(fake.associated(P.line, ids.line, P.quote), [ids.quote]);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM runs WHERE mode = 'incremental' AND NOT dry_run AND status = 'ok'`))[0].n, 1);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM run_lock`))[0].n, 0);
  });
});

test('CLI: Sync now on the admin page starts a run of the running service, and a paused schedule stays paused after a restart', async () => {
  await withFakePortal(async ({ fake, env, sql }) => {
    seedFamily(fake);
    const port = await freePort();
    const password = 'a long admin password';
    const base = `http://127.0.0.1:${port}`;
    const serviceEnv = { ...env, RUN_INTERVAL_MINUTES: '30', PORT: String(port), ADMIN_PASSWORD: password };
    const form = (fields) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    const healthy = () => waitFor(async () => {
      try {
        return (await fetch(`${base}/healthz`)).status === 200;
      } catch {
        return false;
      }
    }, 'the health check');
    const runsFinished = (service) => (service.out.stdout.match(/"msg":"run finished"/g) || []).length;
    async function signIn() {
      const response = await fetch(`${base}/login`, form({ password }));
      assert.equal(response.status, 303);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
      return { cookie, page, csrf: page.match(/name="csrf" value="([^"]+)"/)[1] };
    }
    const post = (session, url, fields = {}) => {
      const request = form({ csrf: session.csrf, ...fields });
      request.headers.cookie = session.cookie;
      return fetch(`${base}${url}`, request);
    };

    // No --apply and no DRY_RUN=false: the service is a dry run, and so is a run started from the page.
    let service = startCli(['start'], serviceEnv);
    try {
      await healthy();
      await waitFor(() => runsFinished(service) === 1, 'the run at start');
      const session = await signIn();
      assert.match(session.page, /<button type="submit">Sync now<\/button>/);
      assert.match(session.page, /Scheduled runs are on: every 30 minutes\./);
      const started = await post(session, '/run');
      assert.equal(started.status, 303);
      assert.equal(started.headers.get('location'), '/?watch=run');
      await waitFor(() => runsFinished(service) === 2, 'the run started from the page');
      const after = await (await fetch(`${base}/?watch=run`, { headers: { cookie: session.cookie }, redirect: 'manual' }));
      assert.equal(after.status, 303);
      assert.equal(after.headers.get('location'), '/?notice=run_finished');
      // Pause, and choose every hour for when it is switched back on.
      assert.equal((await post(session, '/schedule', { interval_minutes: '60' })).status, 303);
    } finally {
      service.child.kill('SIGTERM');
    }
    let result = await service.done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    let lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((l) => l.msg === 'service starting' && l.schedule === 'on' && l.dryRun === true));
    assert.ok(lines.some((l) => l.msg === 'run started from the admin page' && l.dryRun === true));
    assert.ok(lines.some((l) => l.msg === 'schedule changed in the admin page' && l.enabled === false && l.intervalMinutes === 60));
    assert.equal(fake.writes.length, 0, 'a dry run service writes nothing, also when the run is started by hand');
    assert.equal((await sql(`SELECT count(*)::int AS n FROM runs WHERE mode = 'incremental' AND dry_run AND status = 'ok'`))[0].n, 2);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM runs WHERE NOT dry_run`))[0].n, 0);
    assert.deepEqual((await sql(`SELECT enabled, interval_minutes FROM schedule_settings`)).map((r) => [r.enabled, Number(r.interval_minutes)]), [[false, 60]]);

    // Restarted: still paused, so no run at start; Sync now still works.
    service = startCli(['start'], serviceEnv);
    try {
      await healthy();
      const session = await signIn();
      assert.match(session.page, /<strong>Scheduled runs are paused\.<\/strong>/);
      assert.match(session.page, /<option value="60" selected>Every hour<\/option>/);
      assert.equal(runsFinished(service), 0);
      assert.equal((await post(session, '/run')).status, 303);
      await waitFor(() => runsFinished(service) === 1, 'the run started from the page');
    } finally {
      service.child.kill('SIGTERM');
    }
    result = await service.done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((l) => l.msg === 'service starting' && l.schedule === 'paused' && l.scheduleFrom === 'the admin page' && l.intervalMinutes === 60));
    assert.ok(lines.some((l) => /scheduled runs are paused/.test(l.msg)));
    const startedByHand = lines.findIndex((l) => l.msg === 'run started from the admin page');
    const firstRunLine = lines.findIndex((l) => l.runId);
    assert.ok(startedByHand !== -1);
    // The only run of this process is the one asked for on the page, after signing in.
    assert.equal(lines.filter((l) => l.msg === 'run started').length, 1);
    assert.ok(firstRunLine > lines.findIndex((l) => l.msg === 'admin signed in'), 'no run before Sync now was pressed');
    assert.equal(fake.writes.length, 0);
    assert.equal((await sql(`SELECT count(*)::int AS n FROM runs WHERE mode = 'incremental' AND dry_run`))[0].n, 3);
    assert.ok(!(result.stdout + result.stderr).includes(TOKEN) && !(result.stdout + result.stderr).includes(password));
  });
});

test('CLI: a failing scheduled run sends the alert through Resend and Slack (local stand-ins), to the recipients kept in the staging database', async () => {
  await withFakePortal(async ({ env, sql }) => {
    const sink = await alertSink();
    const port = await freePort();
    const service = startCli(['start'], {
      ...env,
      HUBSPOT_PRIVATE_APP_TOKEN: 'not-the-token',
      PORT: String(port),
      RESEND_API_KEY: 're_test_CLI',
      RESEND_API_BASE: `${sink.base}/resend`,
      ALERT_EMAIL_FROM: 'alerts@patchops.example',
      ALERT_EMAIL_TO: 'ops@example.com, zach@example.com',
      ALERT_SLACK_WEBHOOK_URL: `${sink.base}/slack-hook`,
    });
    try {
      await waitFor(() => sink.received.length >= 2, 'the alert');
    } finally {
      service.child.kill('SIGTERM');
    }
    const result = await service.done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    await sink.close();

    const email = sink.received.find((r) => r.path === '/resend/emails');
    assert.equal(email.authorization, 'Bearer re_test_CLI');
    assert.equal(email.body.from, 'alerts@patchops.example');
    assert.deepEqual(email.body.to, ['ops@example.com', 'zach@example.com']);
    assert.equal(email.body.subject, 'Industrious association cleanup: run FAILED (dry run)');
    assert.match(email.body.text, /finished with status: failed/);
    const slack = sink.received.find((r) => r.path === '/slack-hook');
    assert.match(slack.body.text, /run FAILED/);
    assert.ok(!JSON.stringify(sink.received).includes('not-the-token'));

    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((l) => l.msg === 'service starting' && l.adminPage === 'off' && l.adminSignIn === 'off' && l.alertEmail === true && l.alertSlack === true));
    assert.ok(!result.stdout.includes('re_test_CLI'));
    const state = await sql(`SELECT failing, last_subject, last_result FROM alert_state`);
    assert.equal(state[0].failing, true);
    assert.deepEqual(state[0].last_result, { email: 'sent', slack: 'sent' });
  });
});
