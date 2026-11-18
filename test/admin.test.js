import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdminServer } from '../src/admin/server.js';
import { createAlerter } from '../src/alerts.js';
import { loadSettings } from '../src/config.js';
import { getAlertSettings, getAlertState, saveAlertSettings } from '../src/db/store.js';
import { executeRun } from '../src/engine/run.js';
import { addQuoteFamily, makeHarness, T } from './helpers.js';

const SECRETS = {
  HUBSPOT_PRIVATE_APP_TOKEN: 'test-HUBSPOT-SECRET-0001',
  ADMIN_PASSWORD: 'correct horse battery staple',
  RESEND_API_KEY: 're_test_RESEND-SECRET-0002',
  ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/T000/B000/SLACK-SECRET-0003',
  DATABASE_URL: 'postgres://app:DB-SECRET-0004@db.internal:5432/railway',
};

// A failed assertion skips the test's own close(); this keeps a failing test from leaving the process running.
const openServers = new Set();
after(async () => {
  for (const admin of openServers) await admin.close().catch(() => {});
});

async function startAdmin(h, { env = {}, fetchImpl, now } = {}) {
  const settings = loadSettings({ ...SECRETS, ALERT_EMAIL_FROM: 'alerts@patchops.example', ...env });
  const sent = [];
  const alerter = createAlerter(settings.alerts, {
    fetchImpl: fetchImpl || (async (url, init) => {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }),
  });
  const admin = createAdminServer({ db: h.db, settings, alerter, logger: h.ctx().logger, now });
  openServers.add(admin);
  const address = await admin.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const bodies = [];

  async function request(method, url, { cookie, form, headers = {}, raw } = {}) {
    const init = { method, redirect: 'manual', headers: { ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (form) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    }
    if (raw !== undefined) init.body = raw;
    const response = await fetch(base + url, init);
    const text = await response.text();
    bodies.push(text, JSON.stringify([...response.headers.entries()]));
    return { status: response.status, headers: response.headers, text };
  }

  async function login(password = SECRETS.ADMIN_PASSWORD) {
    const response = await request('POST', '/login', { form: { password } });
    const setCookie = response.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.split(';')[0] : null;
    let csrf = null;
    if (cookie) {
      const page = await request('GET', '/', { cookie });
      csrf = page.text.match(/name="csrf" value="([^"]+)"/)?.[1] || null;
    }
    return { response, setCookie, cookie, csrf };
  }

  return { admin, base, request, login, sent, bodies, settings, close: async () => { openServers.delete(admin); await admin.close(); } };
}

test('admin: nothing but the health check, the stylesheet and the sign-in page is reachable without signing in', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);

  const health = await a.request('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.text, '{"status":"ok"}');
  assert.equal((await a.request('GET', '/assets/admin.css')).status, 200);

  const home = await a.request('GET', '/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/login');
  const loginPage = await a.request('GET', '/login');
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /type="password"/);

  for (const [method, url] of [['POST', '/alerts'], ['POST', '/alerts/test'], ['POST', '/logout'], ['GET', '/alerts'], ['GET', '/anything']]) {
    const response = await a.request(method, url, method === 'POST' ? { form: { enabled: '1', recipients: 'x@example.com', repeat_minutes: '5' } } : {});
    assert.equal(response.status, 401, `${method} ${url}`);
    assert.doesNotMatch(response.text, /Send alerts|Last run/);
  }
  assert.deepEqual((await getAlertSettings(h.db)).emailRecipients, []);
  assert.equal(a.sent.length, 0);

  // Every response carries the hardening headers.
  for (const response of [home, loginPage, health]) {
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  }
  assert.equal(loginPage.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(loginPage.text, /<script/i);
  await a.close();
  await h.cleanup();
});

test('admin: without ADMIN_PASSWORD (or with a short one) the page is switched off; the health check still answers', async () => {
  const h = await makeHarness();
  for (const password of ['', 'short']) {
    const a = await startAdmin(h, { env: { ADMIN_PASSWORD: password } });
    assert.equal(a.admin.enabled, false);
    assert.equal((await a.request('GET', '/healthz')).status, 200);
    for (const [method, url] of [['GET', '/'], ['GET', '/login'], ['POST', '/login'], ['POST', '/alerts']]) {
      const response = await a.request(method, url, method === 'POST' ? { form: { password } } : {});
      assert.equal(response.status, 503, `${method} ${url}`);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    await a.close();
  }
  await h.cleanup();
});

test('admin: signing in needs the password; the session cookie is HttpOnly, Secure and SameSite=Strict; signing out ends the session', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);

  const wrong = await a.login('not the password');
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.setCookie, null);
  assert.match(wrong.response.text, /not correct/);

  const ok = await a.login();
  assert.equal(ok.response.status, 303);
  assert.equal(ok.response.headers.get('location'), '/');
  assert.match(ok.setCookie, /^__Host-ia_admin=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  assert.ok(ok.csrf);

  const page = await a.request('GET', '/', { cookie: ok.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Alert settings/);
  assert.match(page.text, /No run has been recorded yet/);
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');

  // A made-up cookie is not a session.
  assert.equal((await a.request('GET', '/', { cookie: '__Host-ia_admin=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status, 303);

  const out = await a.request('POST', '/logout', { cookie: ok.cookie, form: { csrf: ok.csrf } });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await a.request('GET', '/', { cookie: ok.cookie })).status, 303);
  await a.close();
  await h.cleanup();
});

test('admin: repeated wrong passwords lock sign-in for a while, even for the right password; sessions expire', async () => {
  const h = await makeHarness();
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const a = await startAdmin(h, { now: () => new Date(clock), env: { ADMIN_SESSION_HOURS: '2' } });

  const early = await a.login();
  assert.equal(early.response.status, 303);

  for (let i = 0; i < 10; i += 1) assert.equal((await a.login(`guess-${i}`)).response.status, 401);
  const locked = await a.login();
  assert.equal(locked.response.status, 429);
  assert.equal(locked.setCookie, null);
  assert.equal(locked.response.headers.get('retry-after'), '900');

  clock += 16 * 60_000;
  assert.equal((await a.login()).response.status, 303);

  // The first session is still good after 1 hour 59 minutes, and gone after 2 hours.
  clock = Date.parse('2026-11-12T11:59:00Z');
  assert.equal((await a.request('GET', '/', { cookie: early.cookie })).status, 200);
  clock = Date.parse('2026-11-12T12:00:01Z');
  assert.equal((await a.request('GET', '/', { cookie: early.cookie })).status, 303);
  await a.close();
  await h.cleanup();
});

test('admin: alert settings are saved to the staging database; bad input is refused and nothing is saved', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);
  const { cookie, csrf } = await a.login();

  const saved = await a.request('POST', '/alerts', { cookie, form: { csrf, enabled: '1', recipients: 'zach@patchops.example, ops@patchops.example\nzach@patchops.example', repeat_minutes: '45' } });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/?notice=saved');
  let settings = await getAlertSettings(h.db);
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.emailRecipients, ['zach@patchops.example', 'ops@patchops.example']);
  assert.equal(settings.repeatMinutes, 45);

  const page = await a.request('GET', '/?notice=saved', { cookie });
  assert.match(page.text, /Alert settings saved\./);
  assert.match(page.text, /zach@patchops\.example\nops@patchops\.example<\/textarea>/);
  assert.match(page.text, /name="repeat_minutes"[^>]*value="45"/);
  assert.match(page.text, /name="enabled" value="1" checked/);
  // The notice text comes from a fixed list, never from the address bar.
  assert.doesNotMatch((await a.request('GET', '/?notice=<b>hello</b>', { cookie })).text, /hello/);

  // Unticking the box switches alerts off.
  await a.request('POST', '/alerts', { cookie, form: { csrf, recipients: 'zach@patchops.example', repeat_minutes: '0' } });
  settings = await getAlertSettings(h.db);
  assert.equal(settings.enabled, false);
  assert.equal(settings.repeatMinutes, 0);
  assert.doesNotMatch((await a.request('GET', '/', { cookie })).text, /name="enabled" value="1" checked/);

  const before = await getAlertSettings(h.db);
  const bad = [
    { recipients: 'not-an-address', repeat_minutes: '10' },
    { recipients: 'ok@example.com, <script>alert(1)</script>', repeat_minutes: '10' },
    { recipients: 'ok@example.com', repeat_minutes: '-5' },
    { recipients: 'ok@example.com', repeat_minutes: '1.5' },
    { recipients: 'ok@example.com', repeat_minutes: '' },
    { recipients: 'ok@example.com', repeat_minutes: '99999' },
    { recipients: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`).join(','), repeat_minutes: '10' },
  ];
  for (const form of bad) {
    const response = await a.request('POST', '/alerts', { cookie, form: { csrf, enabled: '1', ...form } });
    assert.equal(response.status, 400, JSON.stringify(form).slice(0, 80));
    assert.match(response.text, /Not saved\./);
    assert.doesNotMatch(response.text, /<script>alert/);
  }
  assert.deepEqual(await getAlertSettings(h.db), before);

  // What was typed is shown again, escaped.
  const echoed = await a.request('POST', '/alerts', { cookie, form: { csrf, recipients: '"><img src=x onerror=alert(1)>', repeat_minutes: '10' } });
  assert.match(echoed.text, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  await a.close();
  await h.cleanup();
});

test('admin: forms are refused without the session token, from another site, in another format, or when too large', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);
  const { cookie, csrf } = await a.login();
  const form = { enabled: '1', recipients: 'attacker@example.com', repeat_minutes: '1' };

  assert.equal((await a.request('POST', '/alerts', { cookie, form })).status, 403);
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf: 'guess' } })).status, 403);
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await a.request('POST', '/alerts/test', { cookie, form: { csrf }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.request('POST', '/login', { form: { password: SECRETS.ADMIN_PASSWORD }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.request('POST', '/alerts', { cookie, raw: JSON.stringify({ ...form, csrf }), headers: { 'content-type': 'application/json' } })).status, 415);
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf, recipients: 'x'.repeat(20_000) } })).status, 413);
  assert.equal((await a.request('PUT', '/alerts', { cookie, form: { ...form, csrf } })).status, 405);
  assert.equal((await a.request('DELETE', '/', { cookie })).status, 405);
  assert.deepEqual((await getAlertSettings(h.db)).emailRecipients, []);
  assert.equal(a.sent.length, 0);

  // An unreadable origin without the browser's own statement of where the request comes from is refused.
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: 'null' } })).status, 403);
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: a.base, 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.deepEqual((await getAlertSettings(h.db)).emailRecipients, []);

  // The same form from the page itself is accepted, with the headers browsers send:
  // current Chrome, Firefox and Safari ...
  const good = await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: a.base, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', referer: `${a.base}/` } });
  assert.equal(good.status, 303);
  // ... a browser that hides the origin of form posts but still says the request is same-origin ...
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } })).status, 303);
  // ... and an older browser that sends Origin only.
  assert.equal((await a.request('POST', '/alerts', { cookie, form: { ...form, csrf }, headers: { origin: a.base } })).status, 303);
  // Signing in from the page itself works with browser headers too.
  const signIn = await a.request('POST', '/login', { form: { password: SECRETS.ADMIN_PASSWORD }, headers: { origin: a.base, 'sec-fetch-site': 'same-origin' } });
  assert.equal(signIn.status, 303);
  await a.close();
  await h.cleanup();
});

test('admin: the test alert goes to the saved recipients through Resend and to Slack, and the result is shown', async () => {
  const h = await makeHarness();
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const a = await startAdmin(h, { now: () => new Date(clock) });
  const { cookie, csrf } = await a.login();

  // Alerts are switched off and there are no recipients: only Slack is set up.
  await a.request('POST', '/alerts', { cookie, form: { csrf, recipients: '', repeat_minutes: '60' } });
  const slackOnly = await a.request('POST', '/alerts/test', { cookie, form: { csrf } });
  assert.equal(slackOnly.status, 200);
  assert.match(slackOnly.text, /Test alert sent \(slack: sent\)/);
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0].url, SECRETS.ALERT_SLACK_WEBHOOK_URL);

  // Straight away again: held back.
  assert.equal((await a.request('POST', '/alerts/test', { cookie, form: { csrf } })).status, 429);
  assert.equal(a.sent.length, 1);

  clock += 60_000;
  await a.request('POST', '/alerts', { cookie, form: { csrf, recipients: 'zach@patchops.example ops@patchops.example', repeat_minutes: '60' } });
  const both = await a.request('POST', '/alerts/test', { cookie, form: { csrf } });
  assert.match(both.text, /Test alert sent \(email: sent; slack: sent\)/);
  const email = a.sent.find((s) => s.url === 'https://api.resend.com/emails');
  assert.equal(email.headers.authorization, `Bearer ${SECRETS.RESEND_API_KEY}`);
  assert.deepEqual(email.body, {
    from: 'alerts@patchops.example',
    to: ['zach@patchops.example', 'ops@patchops.example'],
    subject: 'Industrious association cleanup: test alert',
    text: email.body.text,
  });
  assert.match(email.body.text, /This is a test alert/);
  const state = await getAlertState(h.db);
  assert.equal(state.lastSubject, 'Industrious association cleanup: test alert');
  assert.deepEqual(state.lastResult, { email: 'sent', slack: 'sent' });
  assert.equal(state.failing, false);
  assert.match((await a.request('GET', '/', { cookie })).text, /Last message: Industrious association cleanup: test alert, 2026-11-12 10:01 UTC \(email: sent; slack: sent\)/);
  await a.close();

  // A channel that fails is reported on the page; no channel at all says so.
  const failing = await startAdmin(h, {
    env: { ALERT_SLACK_WEBHOOK_URL: '' },
    fetchImpl: async () => new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The patchops.example domain is not verified.' }), { status: 403 }),
  });
  const s2 = await failing.login();
  const failed = await failing.request('POST', '/alerts/test', { cookie: s2.cookie, form: { csrf: s2.csrf } });
  assert.match(failed.text, /Test alert: email: failed: Resend returned 403: The patchops\.example domain is not verified\./);
  await failing.close();

  const none = await startAdmin(h, { env: { ALERT_SLACK_WEBHOOK_URL: '', RESEND_API_KEY: '' } });
  const s3 = await none.login();
  const nothing = await none.request('POST', '/alerts/test', { cookie: s3.cookie, form: { csrf: s3.csrf } });
  assert.match(nothing.text, /Nothing was sent: no alert channel is set up/);
  assert.match(nothing.text, /Email \(Resend\)<\/strong> Not set up/);
  assert.match(nothing.text, /Slack<\/strong> Not set up/);
  await none.close();
  await h.cleanup();
});

test('admin: the page shows the last run status and never contains a secret, even when an error message carries one', async () => {
  const h = await makeHarness();
  const { fake } = h;
  const family = addQuoteFamily(fake, { quote: 'Q1', customer: 'C1', contactNumber: '1' });
  const orphan = fake.addRecord(T.line, { epicor_quote_num: 'NONE' });
  fake.advance(10);
  const a = await startAdmin(h, { env: { DRY_RUN: 'false', RUN_INTERVAL_MINUTES: '30' } });
  const { cookie, csrf } = await a.login();

  await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  let page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<span class="badge good">OK<\/span> <span class="badge info">Dry run<\/span>/);
  assert.match(page.text, /<td>Lines to header<\/td><td class="num">3<\/td><td class="num">2<\/td><td class="num">1<\/td><td class="num">0<\/td><td class="num">0<\/td>/);
  assert.match(page.text, /Would fill/);
  assert.match(page.text, /Live: scheduled runs write to HubSpot/);
  assert.match(page.text, /Every 30 minutes/);

  fake.advance(30);
  const live = await executeRun(h.ctx(), { mode: 'full' });
  page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<span class="badge good">OK<\/span> <span class="badge live">Live<\/span>/);
  assert.match(page.text, /Reconciliation/);
  assert.ok(page.text.includes(live.runId));
  assert.match(page.text, /Deal amounts: 0 updated, 0 held for review, 0 failed\./);

  // A deal amount change held by the guard is counted on the page.
  fake.advance(30);
  fake.updateRecord(T.header, family.header, { quote_amount: '0' });
  fake.advance(10);
  await executeRun(h.ctx(), { mode: 'incremental' });
  page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /Deal amounts: 0 updated, 1 held for review, 0 failed\./);

  // A failed run whose error text happens to contain secrets and markup.
  fake.advance(30);
  fake.failNext({
    pathIncludes: '/search',
    status: 401,
    body: { status: 'error', message: `bad token ${SECRETS.HUBSPOT_PRIVATE_APP_TOKEN} for ${SECRETS.DATABASE_URL} <img src=x onerror=alert(1)>` },
  });
  const failed = await executeRun(h.ctx(), { mode: 'incremental' });
  assert.equal(failed.status, 'failed');
  page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<span class="badge bad">Failed<\/span>/);
  assert.match(page.text, /bad token \[hidden\] for \[hidden\] &lt;img src=x onerror=alert\(1\)&gt;/);

  await a.request('POST', '/alerts', { cookie, form: { csrf, enabled: '1', recipients: 'zach@patchops.example', repeat_minutes: '30' } });
  await a.request('POST', '/alerts/test', { cookie, form: { csrf } });
  await a.request('GET', '/', { cookie });
  await a.login('wrong');

  const everything = a.bodies.join('\n');
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!everything.includes(value), `${name} must never be sent to the browser`);
  }
  for (const fragment of ['HUBSPOT-SECRET', 'RESEND-SECRET', 'SLACK-SECRET', 'DB-SECRET', 'hooks.slack.test', 'db.internal']) {
    assert.ok(!everything.includes(fragment), fragment);
  }
  // No field asks for a secret: the only inputs are the password box, the session token and the three alert fields.
  const inputs = [...everything.matchAll(/<(?:input|textarea|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(inputs)].sort(), ['csrf', 'enabled', 'password', 'recipients', 'repeat_minutes']);
  assert.ok(orphan);
  await a.close();
  await h.cleanup();
});

test('admin: nothing on the page can write to HubSpot', async () => {
  const h = await makeHarness();
  const { fake } = h;
  addQuoteFamily(fake, { quote: 'Q1', customer: 'C1', contactNumber: '1' });
  const a = await startAdmin(h);
  const { cookie, csrf } = await a.login();

  // Use every control the page has, and try a few it does not have.
  await a.request('GET', '/', { cookie });
  await a.request('POST', '/alerts', { cookie, form: { csrf, enabled: '1', recipients: 'zach@patchops.example', repeat_minutes: '30' } });
  await a.request('POST', '/alerts/test', { cookie, form: { csrf } });
  for (const url of ['/run', '/reconcile', '/apply', '/cleanup-contacts', '/mapping', '/settings', '/dry-run']) {
    assert.equal((await a.request('POST', url, { cookie, form: { csrf, apply: '1', dry_run: 'false' } })).status, 404, url);
    assert.equal((await a.request('GET', url, { cookie })).status, 404, url);
  }
  assert.equal(fake.requests.length, 0, 'the admin page never calls HubSpot');
  assert.equal(await h.count('runs'), 0);

  // The page has exactly three forms, and none of them is about runs or mappings.
  const page = await a.request('GET', '/', { cookie });
  const actions = [...page.text.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(actions, ['/alerts', '/alerts/test', '/logout']);
  assert.doesNotMatch(page.text, /<a\s/i);

  // The admin code has no way to reach HubSpot: it imports neither the HubSpot client nor the run engine.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'admin');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /hubspot\/|engine\/|HubSpotClient|HubSpotApi|executeRun/, file);
    assert.doesNotMatch(source.replace(/^\s*(\/\/|\*).*$/gm, ''), /hubspotToken(?!,\n)/, file);
  }
  // alerts.js, the only other module it uses that sends anything, does not import them either.
  const alerts = fs.readFileSync(path.join(dir, '..', 'alerts.js'), 'utf8');
  assert.doesNotMatch(alerts, /hubspot\/|engine\//);
  await a.close();
  await h.cleanup();
});

test('admin: settings saved in the page are what the alerting uses, and they survive a restart of the service', async () => {
  const h = await makeHarness();
  await saveAlertSettings(h.db, { enabled: true, emailRecipients: ['first@example.com'], repeatMinutes: 60, now: new Date() });
  const a = await startAdmin(h);
  const { cookie, csrf } = await a.login();
  await a.request('POST', '/alerts', { cookie, form: { csrf, enabled: '1', recipients: 'second@example.com', repeat_minutes: '15' } });
  await a.close();

  const b = await startAdmin(h);
  const again = await b.login();
  const page = await b.request('GET', '/', { cookie: again.cookie });
  assert.match(page.text, />second@example\.com<\/textarea>/);
  // Sessions are kept in memory: the old cookie does not work on the restarted service.
  assert.equal((await b.request('GET', '/', { cookie })).status, 303);
  await b.close();
  await h.cleanup();
});
