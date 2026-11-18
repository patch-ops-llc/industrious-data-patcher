import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword } from '../src/admin/password.js';
import { createAdminServer } from '../src/admin/server.js';
import { createAlerter } from '../src/alerts.js';
import { loadSettings } from '../src/config.js';
import { finishRun, getAdminPassword, getAlertSettings, getAlertState, getScheduleSettings, insertRun, saveAlertSettings, saveScheduleSettings } from '../src/db/store.js';
import { executeRun } from '../src/engine/run.js';
import { effectiveSchedule } from '../src/schedule.js';
import { startScheduler } from '../src/scheduler.js';
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

async function startAdmin(h, { env = {}, fetchImpl, now, runs = null } = {}) {
  const settings = loadSettings({ ...SECRETS, ALERT_EMAIL_FROM: 'alerts@patchops.example', ...env });
  const sent = [];
  const alerter = createAlerter(settings.alerts, {
    fetchImpl: fetchImpl || (async (url, init) => {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }),
  });
  const admin = createAdminServer({ db: h.db, settings, alerter, logger: h.ctx().logger, now, runs });
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

test('admin: nothing but the health check, the page assets and the sign-in page is reachable without signing in', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);

  const health = await a.request('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.text, '{"status":"ok"}');
  // The stylesheet, logo, icons and font the pages use are served by the service itself.
  const assets = {
    '/assets/admin.css': 'text/css; charset=utf-8',
    '/assets/logo.svg': 'image/svg+xml',
    '/assets/gear.svg': 'image/svg+xml',
    '/assets/chevron.svg': 'image/svg+xml',
    '/assets/favicon.png': 'image/png',
    '/assets/apple-touch-icon.png': 'image/png',
    '/assets/montserrat-latin.woff2': 'font/woff2',
  };
  for (const [url, type] of Object.entries(assets)) {
    const asset = await a.request('GET', url);
    assert.equal(asset.status, 200, url);
    assert.equal(asset.headers.get('content-type'), type, url);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff', url);
  }
  for (const url of ['/assets/', '/assets/admin.css/', '/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/montserrat-OFL.txt', '/assets/password.js']) {
    assert.notEqual((await a.request('GET', url)).status, 200, url);
  }

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
    // Nothing may load from anywhere but this service, and no script at all.
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  }
  assert.equal(loginPage.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(loginPage.text, /<script/i);

  // The branding is bundled: the pages and the stylesheet point at no other site.
  const { cookie } = await a.login();
  const dashboard = await a.request('GET', '/', { cookie });
  const stylesheet = await a.request('GET', '/assets/admin.css');
  for (const [name, text] of [['sign-in page', loginPage.text], ['admin page', dashboard.text], ['stylesheet', stylesheet.text]]) {
    assert.doesNotMatch(text, /https?:\/\/|url\(\s*["']?\/\//i, name);
  }
  for (const page of [loginPage.text, dashboard.text]) {
    assert.match(page, /<img class="logo" src="\/assets\/logo\.svg" alt="Industrious Group"/);
    assert.match(page, /<link rel="stylesheet" href="\/assets\/admin\.css\?v=[0-9a-f]{12}">/);
    assert.doesNotMatch(page, /style=|<style/i);
  }
  const used = [...stylesheet.text.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(used.length > 0 && used.every((url) => Object.hasOwn(assets, url)), used.join(' '));
  // Headings are set in capitals by the stylesheet, not typed in capitals.
  assert.match(stylesheet.text, /h1, h2 \{[^}]*text-transform: uppercase/);
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
  assert.match(page.text, /Link health, run status and alerts/);
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
  assert.match(page.text, /<td>Lines to header<\/td><td class="num" data-label="Checked">3<\/td><td class="num" data-label="Would fill">2<\/td><td class="num" data-label="No match">1<\/td><td class="num" data-label="Held for review">0<\/td><td class="num" data-label="Failed">0<\/td>/);
  assert.match(page.text, /Would fill/);
  assert.match(page.text, /<p class="stat-label">Held for review<\/p>\n<p class="stat-value">0<\/p>/);
  assert.match(page.text, /Live: runs write to HubSpot/);
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
  assert.match(page.text, /<div class="stat warn">\n<p class="stat-label">Held for review<\/p>\n<p class="stat-value">1<\/p>\n<p class="stat-note">0 associations, 1 deal amount<\/p>/);

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
  // No field asks for any other secret: the only inputs are the password boxes, the session token and the three alert fields.
  const inputs = [...everything.matchAll(/<(?:input|textarea|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(inputs)].sort(), ['confirm_password', 'csrf', 'current_password', 'enabled', 'new_password', 'password', 'recipients', 'repeat_minutes']);
  // Password boxes are never filled in by the server.
  assert.doesNotMatch(everything, /<input[^>]*type="password"[^>]*value=/);
  assert.ok(orphan);
  await a.close();
  await h.cleanup();
});

test('admin: link health shows, for each kind of record, how many are linked to the record their ID matches, as of the last finished run', async () => {
  const h = await makeHarness();
  const { fake } = h;
  addQuoteFamily(fake, { quote: 'Q1', customer: 'C1', contactNumber: '1' });
  fake.addRecord(T.line, { epicor_quote_num: 'NONE' });
  fake.addRecord(T.line, { epicor_quote_num: '' });
  fake.advance(10);
  const a = await startAdmin(h);
  const { cookie } = await a.login();
  const card = (text) => text.slice(text.indexOf('<h2>Link health</h2>'), text.indexOf('<h2>Last run</h2>'));
  const row = (text, name) => card(text).split('<li class="health-row">').find((part) => part.includes(`<p class="health-name">${name}</p>`));
  const lines = 'Quote line <span class="health-to">to</span> Quote header';
  const tasks = 'Quote task <span class="health-to">to</span> Quote header';

  // Before any run there is nothing to show yet, and the page says where the figures will come from.
  let page = await a.request('GET', '/', { cookie });
  assert.ok(page.text.indexOf('<h2>Link health</h2>') < page.text.indexOf('<h2>Last run</h2>'), 'link health comes first');
  assert.match(card(page.text), /Every run works this out; the figures appear here when the next run has finished\./);
  assert.doesNotMatch(card(page.text), /health-row/);

  // A dry run: what is linked now, and what a live run would link.
  await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' });
  page = await a.request('GET', '/', { cookie });
  assert.match(card(page.text), /As of the sync finished <span class="nowrap">2026-11-01 00:10 UTC<\/span>\. That was a dry run, so nothing was linked by it\./);
  assert.match(row(page.text, lines), /<p class="hint">4 records, 3 with an ID\. Matched on <code>epicor_quote_num<\/code>\.<\/p>/);
  assert.match(row(page.text, lines), /<p class="health-share">0%<\/p>\n<p class="health-count"><strong>0<\/strong> of 3 linked<\/p>/);
  assert.match(row(page.text, lines), /<rect class="fill" width="0\.00%" height="8"><\/rect>/);
  assert.deepEqual([...row(page.text, lines).matchAll(/<li class="chip (\w+)">(.*?)<\/li>/g)].map((m) => [m[1], m[2]]), [
    ['warn', '<strong>2</strong> would be linked by a live run'],
    ['warn', '<strong>1</strong> matches no Quote header'],
    ['quiet', '<strong>1</strong> has no ID'],
  ]);
  assert.match(row(page.text, 'IC code <span class="health-to">to</span> Company'), /<p class="health-share">&ndash;<\/p>[\s\S]*No records yet/);

  // A live run: the same records, now linked.
  fake.advance(30);
  const live = await executeRun(h.ctx(), { mode: 'full' });
  page = await a.request('GET', '/', { cookie });
  assert.match(card(page.text), /As of the reconciliation finished <span class="nowrap">2026-11-01 00:40 UTC<\/span>\.<\/p>/);
  assert.doesNotMatch(card(page.text), /dry run|would be linked/);
  assert.match(row(page.text, lines), /<p class="health-share">66\.6%<\/p>\n<p class="health-count"><strong>2<\/strong> of 3 linked<\/p>/);
  assert.match(row(page.text, lines), /<svg class="health-bar" role="img" aria-label="66\.6% linked" width="100%" height="8" focusable="false"><rect class="track" width="100%" height="8"><\/rect><rect class="fill" width="66\.67%" height="8"><\/rect><\/svg>/);
  assert.deepEqual([...row(page.text, lines).matchAll(/<li class="chip (\w+)">(.*?)<\/li>/g)].map((m) => [m[1], m[2]]), [
    ['warn', '<strong>1</strong> matches no Quote header'],
    ['quiet', '<strong>1</strong> has no ID'],
  ]);
  assert.match(row(page.text, tasks), /<p class="health-share good">100%<\/p>\n<p class="health-count"><strong>1<\/strong> of 1 linked<\/p>/);
  assert.match(row(page.text, tasks), /<rect class="fill good" width="100\.00%" height="8"><\/rect>/);
  assert.deepEqual([...row(page.text, tasks).matchAll(/<li class="chip (\w+)">(.*?)<\/li>/g)].map((m) => [m[1], m[2]]), [['good', 'Every record is linked']]);
  // The figures are the run's own: linked is what it found in place plus what it created.
  const rule = h.rule(live, 'lines_to_header');
  assert.equal(rule.alreadyAssociated + rule.created, 2);
  const liveCard = card(page.text);

  // A run in progress, and a run that failed before it got to the associations, leave the last figures in place.
  fake.advance(30);
  fake.failNext({ pathIncludes: '/search', status: 500, times: 50 });
  assert.equal((await executeRun(h.ctx(), { mode: 'incremental' })).status, 'failed');
  page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<span class="badge bad">Failed<\/span>/);
  assert.equal(card(page.text), liveCard);
  fake.advance(30);
  await insertRun(h.db, { runId: 'still-running', mode: 'incremental', dryRun: false, limit: null, startedAt: new Date(fake.clock).toISOString() });
  page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<span class="badge info">Running<\/span>/);
  assert.equal(card(page.text), liveCard);

  // Large numbers, a record without an ID next to a full score, a limited run, and text that must be escaped.
  fake.advance(30);
  const crafted = {
    runId: 'crafted',
    mode: 'incremental',
    dryRun: false,
    limit: 25,
    startedAt: new Date(fake.clock).toISOString(),
    finishedAt: new Date(fake.clock + 60_000).toISOString(),
    status: 'ok',
    stateSaved: true,
    health: [
      { from: 'x', to: 'y', fromLabel: 'Line <b>item</b>', toLabel: 'Quote & "co"', rules: ['r'], keys: ['a<i>', 'b + c'], records: 29838, withKey: 29838, linked: 29837, pending: 3, failed: 2, held: 4, noMatch: 76, noKey: 0 },
      { from: 'p', to: 'q', fromLabel: 'Task', toLabel: 'Quote', rules: ['s'], keys: ['quote_id'], records: 12873, withKey: 11058, linked: 11058, pending: 0, failed: 0, held: 0, noMatch: 0, noKey: 1815 },
    ],
  };
  await insertRun(h.db, crafted);
  await finishRun(h.db, crafted, { compact: crafted });
  page = await a.request('GET', '/', { cookie });
  const text = card(page.text);
  assert.match(text, /That run was limited to 25 records per association\./);
  assert.match(text, /<p class="health-name">Line &lt;b&gt;item&lt;\/b&gt; <span class="health-to">to<\/span> Quote &amp; &quot;co&quot;<\/p>/);
  assert.match(text, /Matched on <code>a&lt;i&gt;<\/code> or <code>b \+ c<\/code>\./);
  assert.doesNotMatch(text, /<b>|<i>/);
  // Rounded down: 29,837 of 29,838 is not shown as 100%.
  assert.match(text, /<p class="health-share">99\.9%<\/p>\n<p class="health-count"><strong>29,837<\/strong> of 29,838 linked<\/p>/);
  assert.match(text, /<li class="chip warn"><strong>3<\/strong> not linked yet<\/li>\n<li class="chip bad"><strong>2<\/strong> failed<\/li>\n<li class="chip warn"><strong>4<\/strong> held for review<\/li>\n<li class="chip warn"><strong>76<\/strong> match no Quote &amp; &quot;co&quot;<\/li>/);
  assert.match(text, /<p class="hint">12,873 records, 11,058 with an ID\. Matched on <code>quote_id<\/code>\.<\/p>/);
  assert.match(text, /<p class="health-share good">100%<\/p>\n<p class="health-count"><strong>11,058<\/strong> of 11,058 linked<\/p>/);
  assert.match(text, /<li class="chip good">Every record with an ID is linked<\/li>\n<li class="chip quiet"><strong>1,815<\/strong> have no ID<\/li>/);

  // The bars are drawn without inline styles or scripts, which the page's security policy does not allow.
  const everything = a.bodies.join('\n');
  assert.doesNotMatch(everything, / style=|<style|<script|onload=|onclick=/i);
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!everything.includes(value), name);
  await a.close();
  await h.cleanup();
});

test('admin: the admin code cannot reach HubSpot itself; without the run control the page cannot start a run', async () => {
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
  assert.equal(fake.requests.length, 0, 'the admin page itself never calls HubSpot');
  assert.equal(await h.count('runs'), 0);

  // Without the run control the page has exactly four forms, and none of them is about runs or mappings.
  const page = await a.request('GET', '/', { cookie });
  const actions = [...page.text.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(actions, ['/alerts', '/alerts/test', '/logout', '/password']);
  assert.equal((page.text.match(/<form/g) || []).length, 4);
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

// ---- changing the password on the page ----------------------------------------

const NEW_PASSWORD = 'a brand new passphrase 2026';
const browser = (a) => ({ origin: a.base, 'sec-fetch-site': 'same-origin' });

/** Fails if any password, or any stored hash, was sent to a browser or written to the log. */
async function assertNoPasswordLeak(h, a, passwords) {
  const stored = await getAdminPassword(h.db);
  const hashes = stored ? [stored.passwordHash, stored.variableHash, ...stored.passwordHash.split('$').slice(4), ...stored.variableHash.split('$').slice(4)] : [];
  const sent = a.bodies.join('\n');
  const logged = JSON.stringify(h.logs);
  for (const value of [...passwords, ...hashes]) {
    assert.ok(!sent.includes(value), 'a password or its hash was sent to the browser');
    assert.ok(!sent.includes(encodeURIComponent(value)), 'a password or its hash was sent to the browser');
    assert.ok(!logged.includes(value), 'a password or its hash was written to the log');
  }
  assert.doesNotMatch(sent, /scrypt\$/);
  assert.doesNotMatch(logged, /scrypt\$/);
}

test('admin password: hashes are salted scrypt, verify only the right password, and a damaged hash matches nothing', async () => {
  const one = await hashPassword(NEW_PASSWORD);
  const two = await hashPassword(NEW_PASSWORD);
  assert.match(one, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  assert.notEqual(one, two, 'every hash has its own salt');
  assert.ok(!one.includes(NEW_PASSWORD));
  assert.equal(await verifyPassword(NEW_PASSWORD, one), true);
  assert.equal(await verifyPassword(NEW_PASSWORD, two), true);
  assert.equal(await verifyPassword(`${NEW_PASSWORD} `, one), false);
  assert.equal(await verifyPassword('', one), false);
  for (const damaged of ['', null, undefined, NEW_PASSWORD, 'scrypt$32768$8$1$$', one.replace('scrypt', 'md5'), one.replace('$32768$', '$0$'), one.replace('$32768$', '$1000$'), one.replace('$32768$', '$1073741824$'), `${one}$extra`]) {
    assert.equal(await verifyPassword(NEW_PASSWORD, damaged), false, String(damaged).slice(0, 30));
  }
});

test('admin password: a wrong current password, a short new one or a mismatched confirmation is refused and nothing changes', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);
  const { cookie, csrf } = await a.login();
  const good = { csrf, current_password: SECRETS.ADMIN_PASSWORD, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD };

  const refused = [
    [403, /Password not changed\. The current password is not correct\./, { ...good, current_password: 'not the current password' }],
    [403, /The current password is not correct\./, { ...good, current_password: '' }],
    [403, /The current password is not correct\./, { ...good, current_password: NEW_PASSWORD }],
    [400, /Password not changed\. The new password must be at least 12 characters\./, { ...good, new_password: 'elevenchars', confirm_password: 'elevenchars' }],
    [400, /at least 12 characters/, { ...good, new_password: '', confirm_password: '' }],
    [400, /at most 200 characters/, { ...good, new_password: 'x'.repeat(201), confirm_password: 'x'.repeat(201) }],
    [400, /The new password and its confirmation are not the same\./, { ...good, confirm_password: `${NEW_PASSWORD}!` }],
    [400, /The new password and its confirmation are not the same\./, { ...good, confirm_password: '' }],
    [400, /The new password must differ from the current one\./, { ...good, new_password: SECRETS.ADMIN_PASSWORD, confirm_password: SECRETS.ADMIN_PASSWORD }],
  ];
  for (const [status, message, form] of refused) {
    const response = await a.request('POST', '/password', { cookie, form, headers: browser(a) });
    assert.equal(response.status, status, String(message));
    assert.match(response.text, message);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.text, /This is still the starting password/);
  }

  // The form is protected like the others: session, session token, same site.
  assert.equal((await a.request('POST', '/password', { form: good })).status, 401);
  assert.equal((await a.request('POST', '/password', { cookie, form: { ...good, csrf: 'guess' } })).status, 403);
  assert.equal((await a.request('POST', '/password', { cookie, form: { ...good, csrf: '' } })).status, 403);
  assert.equal((await a.request('POST', '/password', { cookie, form: good, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.request('POST', '/password', { cookie, form: good, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await a.request('GET', '/password', { cookie })).status, 404);

  assert.equal(await getAdminPassword(h.db), null);
  assert.equal(await h.count('admin_password'), 0);
  assert.equal(await a.admin.passwordSource(), 'variable');
  // Still signed in, and the starting password still works.
  assert.equal((await a.request('GET', '/', { cookie })).status, 200);
  assert.equal((await a.login()).response.status, 303);
  assert.equal((await a.login(NEW_PASSWORD)).response.status, 401);

  assert.ok(h.logs.some((l) => l.level === 'warn' && /password change refused/.test(l.msg)));
  await assertNoPasswordLeak(h, a, [SECRETS.ADMIN_PASSWORD, NEW_PASSWORD, 'not the current password', 'elevenchars']);
  await a.close();
  await h.cleanup();
});

test('admin password: changing it stores only a salted hash, signs out every other session, and retires ADMIN_PASSWORD', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);
  const mine = await a.login();
  const other = await a.login();
  assert.equal((await a.request('GET', '/', { cookie: other.cookie })).status, 200);

  const changed = await a.request('POST', '/password', {
    cookie: mine.cookie,
    form: { csrf: mine.csrf, current_password: SECRETS.ADMIN_PASSWORD, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD },
    headers: browser(a),
  });
  assert.equal(changed.status, 303);
  assert.equal(changed.headers.get('location'), '/?notice=password_changed');
  assert.match(changed.headers.get('set-cookie'), /^__Host-ia_admin=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const fresh = changed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(fresh, mine.cookie);

  // The other session is signed out, and so is the old cookie of the one that made the change.
  assert.equal((await a.request('GET', '/', { cookie: other.cookie })).status, 303);
  assert.equal((await a.request('GET', '/', { cookie: mine.cookie })).status, 303);
  assert.equal((await a.request('POST', '/alerts', { cookie: other.cookie, form: { csrf: other.csrf, enabled: '1', recipients: 'x@example.com', repeat_minutes: '5' } })).status, 401);
  const page = await a.request('GET', '/?notice=password_changed', { cookie: fresh });
  assert.equal(page.status, 200);
  assert.match(page.text, /Password changed\. Every other session was signed out\./);
  assert.match(page.text, /Set on this page on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. The ADMIN_PASSWORD service variable no longer signs in\./);
  // The old session token is gone with the old session.
  const freshCsrf = page.text.match(/name="csrf" value="([^"]+)"/)[1];
  assert.notEqual(freshCsrf, mine.csrf);

  // Only hashes are in the staging database.
  const { rows } = await h.db.query('SELECT * FROM admin_password');
  assert.equal(rows.length, 1);
  const row = JSON.stringify(rows[0]);
  assert.ok(!row.includes(NEW_PASSWORD) && !row.includes(SECRETS.ADMIN_PASSWORD));
  assert.match(rows[0].password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.match(rows[0].variable_hash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(rows[0].password_hash.split('$')[4], rows[0].variable_hash.split('$')[4], 'each hash has its own salt');
  assert.equal(await verifyPassword(NEW_PASSWORD, rows[0].password_hash), true);
  assert.equal(await verifyPassword(SECRETS.ADMIN_PASSWORD, rows[0].password_hash), false);
  assert.equal(await a.admin.passwordSource(), 'page');

  // The variable's value no longer signs in; the new password does.
  const old = await a.login();
  assert.equal(old.response.status, 401);
  assert.equal(old.setCookie, null);
  assert.equal((await a.login(NEW_PASSWORD)).response.status, 303);

  // The variable's value is no longer the current password for a second change either.
  const second = { csrf: freshCsrf, current_password: SECRETS.ADMIN_PASSWORD, new_password: 'yet another passphrase', confirm_password: 'yet another passphrase' };
  assert.equal((await a.request('POST', '/password', { cookie: fresh, form: second })).status, 403);
  const again = await a.request('POST', '/password', { cookie: fresh, form: { ...second, current_password: NEW_PASSWORD } });
  assert.equal(again.status, 303);
  assert.equal((await a.login(NEW_PASSWORD)).response.status, 401);
  assert.equal((await a.login('yet another passphrase')).response.status, 303);
  assert.equal(await h.count('admin_password'), 1);

  assert.ok(h.logs.some((l) => l.msg === 'admin password changed on the admin page' && l.otherSessionsSignedOut === 1));
  await assertNoPasswordLeak(h, a, [SECRETS.ADMIN_PASSWORD, NEW_PASSWORD, 'yet another passphrase']);
  // Nothing the page does reaches HubSpot.
  assert.equal(h.fake.requests.length, 0);
  await a.close();
  await h.cleanup();
});

test('admin password: it survives a restart, and giving ADMIN_PASSWORD a new value resets it to the variable', async () => {
  const h = await makeHarness();
  const a = await startAdmin(h);
  const { cookie, csrf } = await a.login();
  const changed = await a.request('POST', '/password', { cookie, form: { csrf, current_password: SECRETS.ADMIN_PASSWORD, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD } });
  assert.equal(changed.status, 303);
  await a.close();

  // Restart with the variable unchanged: the page password stands, the variable does not sign in.
  const b = await startAdmin(h);
  assert.equal(await b.admin.passwordSource(), 'page');
  assert.equal((await b.login()).response.status, 401);
  assert.equal((await b.login(NEW_PASSWORD)).response.status, 303);
  assert.equal(await h.count('admin_password'), 1);
  await b.close();

  // Recovery: the variable is given a new value. The stored password is removed and the variable is the password again.
  const RECOVERY = 'recovery value set in railway';
  const c = await startAdmin(h, { env: { ADMIN_PASSWORD: RECOVERY } });
  assert.equal(await c.admin.passwordSource(), 'variable');
  assert.equal(await h.count('admin_password'), 0);
  assert.equal((await c.login(NEW_PASSWORD)).response.status, 401);
  assert.equal((await c.login()).response.status, 401, 'the old variable value does not come back either');
  const recovered = await c.login(RECOVERY);
  assert.equal(recovered.response.status, 303);
  assert.match((await c.request('GET', '/', { cookie: recovered.cookie })).text, /This is still the starting password/);
  assert.ok(h.logs.some((l) => l.level === 'warn' && /ADMIN_PASSWORD has a new value/.test(l.msg)));

  // From there the password can be changed on the page again, and that holds across a restart.
  const next = await c.request('POST', '/password', { cookie: recovered.cookie, form: { csrf: recovered.csrf, current_password: RECOVERY, new_password: 'third passphrase here', confirm_password: 'third passphrase here' } });
  assert.equal(next.status, 303);
  await assertNoPasswordLeak(h, c, [SECRETS.ADMIN_PASSWORD, NEW_PASSWORD, RECOVERY, 'third passphrase here']);
  await c.close();
  const d = await startAdmin(h, { env: { ADMIN_PASSWORD: RECOVERY } });
  assert.equal((await d.login(RECOVERY)).response.status, 401);
  assert.equal((await d.login('third passphrase here')).response.status, 303);
  await d.close();

  // Recovery also works without anyone visiting the page first: signing in applies it.
  const e = await startAdmin(h, { env: { ADMIN_PASSWORD: 'second recovery value' } });
  assert.equal((await e.login('third passphrase here')).response.status, 401);
  assert.equal(await h.count('admin_password'), 0);
  assert.equal((await e.login('second recovery value')).response.status, 303);
  await e.close();

  // Without a usable ADMIN_PASSWORD the page stays off, whatever is stored.
  const f = await startAdmin(h, { env: { ADMIN_PASSWORD: '' } });
  assert.equal(await f.admin.passwordSource(), 'off');
  assert.equal((await f.request('POST', '/login', { form: { password: 'third passphrase here' } })).status, 503);
  await f.close();
  await h.cleanup();
});

test('admin password: wrong current passwords count towards the sign-in lock', async () => {
  const h = await makeHarness();
  let clock = Date.parse('2026-11-18T10:00:00Z');
  const a = await startAdmin(h, { now: () => new Date(clock) });
  const { cookie, csrf } = await a.login();
  const form = { csrf, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD };

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await a.request('POST', '/password', { cookie, form: { ...form, current_password: `guess number ${i}` } })).status, 403);
  }
  // Locked now, even with the right current password, and for signing in too.
  const locked = await a.request('POST', '/password', { cookie, form: { ...form, current_password: SECRETS.ADMIN_PASSWORD } });
  assert.equal(locked.status, 429);
  assert.match(locked.text, /Password not changed\. Too many wrong passwords\./);
  assert.equal((await a.login()).response.status, 429);
  assert.equal(await h.count('admin_password'), 0);

  clock += 16 * 60_000;
  assert.equal((await a.request('POST', '/password', { cookie, form: { ...form, current_password: SECRETS.ADMIN_PASSWORD } })).status, 303);
  assert.equal(await h.count('admin_password'), 1);
  await a.close();
  await h.cleanup();
});

// ---- Sync now and the schedule -------------------------------------------------

const tick = () => new Promise((r) => setImmediate(r));

async function untilIdle(scheduler) {
  const deadline = Date.now() + 20_000;
  while (scheduler.status().running) {
    if (Date.now() > deadline) throw new Error('the run did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A scheduler like the service's, with timers that never fire by themselves and runs that can be held open. */
function testScheduler({ task, enabled = true, intervalMinutes = 30, now, held = false }) {
  const timers = [];
  const cleared = [];
  let release = () => {};
  let gate = held ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const triggers = [];
  const scheduler = startScheduler({
    intervalMs: intervalMinutes * 60_000,
    enabled,
    now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { cleared.push(id); },
    task: async ({ trigger }) => {
      triggers.push(trigger);
      await gate;
      await task?.({ trigger });
    },
  });
  return {
    scheduler,
    timers,
    cleared,
    triggers,
    holdNextRun() { gate = new Promise((resolve) => { release = resolve; }); },
    releaseRun() { release(); gate = Promise.resolve(); },
  };
}

test('admin sync: Sync now starts the service\'s own run, one at a time; in a dry run service nothing is written to HubSpot', async () => {
  const h = await makeHarness();
  addQuoteFamily(h.fake, { quote: 'Q1', customer: 'C1', contactNumber: '1' });
  const summaries = [];
  // The service starts with a scheduled run; it is held open here.
  const s = testScheduler({ held: true, task: async () => { summaries.push(await executeRun(h.ctx({ dryRun: true }), { mode: 'incremental' })); } });
  const a = await startAdmin(h, { runs: s.scheduler });
  const { cookie, csrf } = await a.login();

  let page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<strong>A scheduled run is in progress<\/strong>, <span class="nowrap">started \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.<\/span>/);
  assert.match(page.text, /<form method="get" action="\/"><input type="hidden" name="watch" value="run"><button type="submit" class="secondary">Follow this run<\/button><\/form>/);
  assert.doesNotMatch(page.text, /action="\/run"/);
  assert.doesNotMatch(page.text, /http-equiv="refresh"/);

  // While a run is going, another cannot be started.
  const busy = await a.request('POST', '/run', { cookie, form: { csrf } });
  assert.equal(busy.status, 409);
  assert.match(busy.text, /Not started: a run is already in progress\./);
  assert.deepEqual(s.triggers, ['schedule']);

  s.releaseRun();
  await untilIdle(s.scheduler);
  assert.equal(summaries.length, 1);
  assert.equal(s.timers.length, 1, 'the next scheduled run is planned');

  page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /<form method="post" action="\/run"><input type="hidden" name="csrf" value="[^"]+"><button type="submit">Sync now<\/button><\/form>/);
  assert.match(page.text, /Next scheduled run: <span class="nowrap">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
  assert.match(page.text, /Dry run: reads from HubSpot, changes nothing\./);

  // The button is protected like every other form.
  assert.equal((await a.request('POST', '/run', { form: { csrf } })).status, 401);
  assert.equal((await a.request('POST', '/run', { cookie, form: {} })).status, 403);
  assert.equal((await a.request('POST', '/run', { cookie, form: { csrf: 'guess' } })).status, 403);
  assert.equal((await a.request('POST', '/run', { cookie, form: { csrf }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await a.request('POST', '/run', { cookie, form: { csrf }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await a.request('GET', '/run', { cookie })).status, 404);
  assert.deepEqual(s.triggers, ['schedule'], 'none of those started a run');

  h.fake.clock += 20 * 60_000;
  s.holdNextRun();
  const started = await a.request('POST', '/run', { cookie, form: { csrf }, headers: browser(a) });
  assert.equal(started.status, 303);
  assert.equal(started.headers.get('location'), '/?watch=run');
  assert.deepEqual(s.triggers, ['schedule', 'manual']);
  assert.deepEqual(s.cleared, [1], 'the planned scheduled run is replaced by this one');
  assert.equal(s.scheduler.status().runningTrigger, 'manual');

  // The page it lands on reloads itself until the run is over.
  const watching = await a.request('GET', '/?watch=run', { cookie });
  assert.equal(watching.status, 200);
  assert.match(watching.text, /<meta http-equiv="refresh" content="5; url=\/\?watch=run">/);
  assert.match(watching.text, /<strong>A run started here is in progress<\/strong>/);
  assert.match(watching.text, /This page reloads every 5 seconds until the run finishes\./);
  assert.match(watching.text, /<p class="notice info" role="status">A run is in progress\. This page reloads every 5 seconds until it finishes\.<\/p>/);
  assert.doesNotMatch(watching.text, /action="\/run"|Follow this run/);
  // The ordinary page does not reload, so nothing typed into a form is lost.
  assert.doesNotMatch((await a.request('GET', '/', { cookie })).text, /http-equiv="refresh"/);

  const again = await a.request('POST', '/run', { cookie, form: { csrf } });
  assert.equal(again.status, 409);
  assert.deepEqual(s.triggers, ['schedule', 'manual']);

  s.releaseRun();
  await untilIdle(s.scheduler);
  const finished = await a.request('GET', '/?watch=run', { cookie });
  assert.equal(finished.status, 303);
  assert.equal(finished.headers.get('location'), '/?notice=run_finished');
  page = await a.request('GET', '/?notice=run_finished', { cookie });
  assert.match(page.text, /The run has finished\. Its result is under Last run\./);
  assert.match(page.text, /<span class="badge good">OK<\/span> <span class="badge info">Dry run<\/span>/);
  assert.ok(page.text.includes(summaries[1].runId));
  assert.doesNotMatch(page.text, /http-equiv="refresh"/);

  // Both runs were dry runs of the service: HubSpot was read, never written.
  assert.equal(summaries.length, 2);
  for (const summary of summaries) {
    assert.equal(summary.status, 'ok');
    assert.equal(summary.dryRun, true);
    assert.equal(summary.api.writes, 0);
  }
  assert.ok(h.fake.requests.length > 0);
  assert.equal(h.fake.writes.length, 0);
  assert.equal(await h.count('runs', 'dry_run'), 2);
  assert.equal(await h.count('runs', 'NOT dry_run'), 0);
  assert.equal(s.timers.length, 2, 'the schedule carries on after a run started by hand');
  assert.ok(h.logs.some((l) => l.msg === 'run started from the admin page' && l.dryRun === true));

  const everything = a.bodies.join('\n');
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!everything.includes(value), name);
  // The run control adds exactly two forms that post, and one that only reloads the page.
  const actions = [...page.text.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(actions, ['/alerts', '/alerts/test', '/logout', '/password', '/run', '/schedule']);
  for (const url of ['/reconcile', '/apply', '/cleanup-contacts', '/mapping', '/settings', '/dry-run', '/run/full', '/schedule/cron']) {
    assert.equal((await a.request('POST', url, { cookie, form: { csrf, apply: '1', dry_run: 'false' } })).status, 404, url);
  }
  await s.scheduler.stop();
  await a.close();
  await h.cleanup();
});

test('admin sync: the page cannot change what a run does; in a live service Sync now is the same run the schedule makes', async () => {
  const h = await makeHarness();
  const family = addQuoteFamily(h.fake, { quote: 'Q1', customer: 'C1', contactNumber: '1' });
  await saveScheduleSettings(h.db, { enabled: false, intervalMinutes: 30, now: new Date() });
  const summaries = [];
  const s = testScheduler({ enabled: false, task: async () => { summaries.push(await executeRun(h.ctx(), { mode: 'incremental' })); } });
  const a = await startAdmin(h, { runs: s.scheduler, env: { DRY_RUN: 'false' } });
  const { cookie, csrf } = await a.login();
  assert.deepEqual(s.triggers, [], 'a paused schedule starts no run by itself');

  const page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /Live: writes to HubSpot, like a scheduled run\./);
  assert.match(page.text, /<strong>Scheduled runs are paused\.<\/strong>/);

  // Extra fields that try to change the run are ignored: the run is the service's own.
  const started = await a.request('POST', '/run', { cookie, form: { csrf, dry_run: 'true', apply: '0', mode: 'full', limit: '1', deal_amounts: '1' } });
  assert.equal(started.status, 303);
  await untilIdle(s.scheduler);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].mode, 'incremental');
  assert.equal(summaries[0].dryRun, false);
  assert.equal(summaries[0].limit, null);
  assert.deepEqual(h.fake.associated(T.line, family.lines[0], T.header), [family.header]);
  assert.ok(h.fake.writes.length > 0);
  assert.equal(s.timers.length, 0, 'paused: no scheduled run is planned after it');
  await s.scheduler.stop();
  await a.close();
  await h.cleanup();
});

test('admin schedule: pause, resume and a fixed list of intervals; saved to the staging database, applied at once, and kept across a restart', async () => {
  const h = await makeHarness();
  let clock = Date.parse('2026-11-18T10:00:00Z');
  const s = testScheduler({ now: () => clock });
  await tick();
  assert.deepEqual(s.triggers, ['schedule']);
  assert.equal(s.timers[0].ms, 30 * 60_000);
  const a = await startAdmin(h, { runs: s.scheduler, now: () => new Date(clock) });
  const { cookie, csrf } = await a.login();
  const options = (text) => [...text.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map((m) => [m[1], Boolean(m[2]), m[3]]);

  let page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /Scheduled runs are on: every 30 minutes\./);
  assert.match(page.text, /Next scheduled run: <span class="nowrap">2026-11-18 10:30 UTC<\/span>/);
  assert.match(page.text, /name="enabled" value="1" checked> Run on a schedule/);
  assert.match(page.text, /This is still the starting schedule, from the RUN_INTERVAL_MINUTES service variable\./);
  assert.deepEqual(options(page.text), [
    ['15', false, 'Every 15 minutes'], ['30', true, 'Every 30 minutes'], ['60', false, 'Every hour'], ['120', false, 'Every 2 hours'],
    ['240', false, 'Every 4 hours'], ['360', false, 'Every 6 hours'], ['720', false, 'Every 12 hours'], ['1440', false, 'Once a day'],
  ]);
  // A fixed list and nothing else: no box to type a schedule into.
  assert.doesNotMatch(page.text, /cron/i);
  assert.doesNotMatch(page.text, /<input[^>]*name="(interval_minutes|schedule|cron)"/);
  assert.equal(await getScheduleSettings(h.db), null);

  // Anything that is not on the list is refused, cron expressions included.
  for (const value of ['45', '7', '', '0', '-30', '1e2', '30 30', '30,60', '*/5 * * * *', '0 9 * * 1-5', '@hourly', '30; DELETE FROM runs', '99999999']) {
    const response = await a.request('POST', '/schedule', { cookie, form: { csrf, enabled: '1', interval_minutes: value } });
    assert.equal(response.status, 400, value);
    assert.match(response.text, /Schedule not saved\. Choose one of the listed intervals\./);
  }
  assert.equal((await a.request('POST', '/schedule', { cookie, form: { csrf, enabled: '1' } })).status, 400);
  assert.equal((await a.request('POST', '/schedule', { form: { csrf, enabled: '1', interval_minutes: '60' } })).status, 401);
  assert.equal((await a.request('POST', '/schedule', { cookie, form: { enabled: '1', interval_minutes: '60' } })).status, 403);
  assert.equal((await a.request('POST', '/schedule', { cookie, form: { csrf, enabled: '1', interval_minutes: '60' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(await getScheduleSettings(h.db), null);
  assert.equal(s.scheduler.status().intervalMs, 30 * 60_000);
  assert.equal(s.timers.length, 1);

  // Every 2 hours.
  clock += 10 * 60_000;
  const saved = await a.request('POST', '/schedule', { cookie, form: { csrf, enabled: '1', interval_minutes: '120' }, headers: browser(a) });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/?notice=schedule_saved');
  let stored = await getScheduleSettings(h.db);
  assert.equal(stored.enabled, true);
  assert.equal(stored.intervalMinutes, 120);
  assert.equal(s.scheduler.status().intervalMs, 120 * 60_000);
  assert.equal(s.scheduler.status().nextRunAt, Date.parse('2026-11-18T12:00:00Z'), 'two hours after the last run started');
  assert.equal(s.timers.at(-1).ms, 110 * 60_000);
  page = await a.request('GET', '/?notice=schedule_saved', { cookie });
  assert.match(page.text, /Schedule saved\./);
  assert.match(page.text, /Scheduled runs are on: every 2 hours\./);
  assert.match(page.text, /Next scheduled run: <span class="nowrap">2026-11-18 12:00 UTC<\/span>/);
  assert.match(page.text, /Set on this page on 2026-11-18 10:10 UTC\. The RUN_INTERVAL_MINUTES service variable no longer applies\./);
  assert.deepEqual(options(page.text).filter((o) => o[1]), [['120', true, 'Every 2 hours']]);

  // Pause: unticking the box. The planned run is dropped; nothing starts by itself.
  const paused = await a.request('POST', '/schedule', { cookie, form: { csrf, interval_minutes: '120' } });
  assert.equal(paused.status, 303);
  stored = await getScheduleSettings(h.db);
  assert.equal(stored.enabled, false);
  assert.equal(stored.intervalMinutes, 120);
  assert.equal(s.scheduler.status().enabled, false);
  assert.equal(s.scheduler.status().nextRunAt, null);
  const timersWhenPaused = s.timers.length;
  assert.ok(s.cleared.includes(timersWhenPaused), 'the pending timer was cancelled');
  page = await a.request('GET', '/', { cookie });
  assert.equal((page.text.match(/<strong>Scheduled runs are paused\.<\/strong>/g) || []).length, 2, 'said next to Sync now and in the Schedule box');
  assert.match(page.text, /name="enabled" value="1"> Run on a schedule/);
  assert.doesNotMatch(page.text, /Next scheduled run/);

  // Sync now still works while paused, and does not bring the schedule back.
  clock += 3 * 3_600_000;
  assert.equal((await a.request('POST', '/run', { cookie, form: { csrf } })).status, 303);
  await untilIdle(s.scheduler);
  assert.deepEqual(s.triggers, ['schedule', 'manual']);
  assert.equal(s.timers.length, timersWhenPaused);
  assert.equal(s.scheduler.status().nextRunAt, null);

  // Resume, every 15 minutes: counted from the run that was just started by hand.
  clock += 5 * 60_000;
  assert.equal((await a.request('POST', '/schedule', { cookie, form: { csrf, enabled: '1', interval_minutes: '15' } })).status, 303);
  assert.equal(s.scheduler.status().enabled, true);
  assert.equal(s.timers.at(-1).ms, 10 * 60_000);
  assert.match((await a.request('GET', '/', { cookie })).text, /Next scheduled run: <span class="nowrap">2026-11-18 13:25 UTC<\/span>/);

  const changes = h.logs.filter((l) => l.msg === 'schedule changed in the admin page').map((l) => [l.enabled, l.intervalMinutes]);
  assert.deepEqual(changes, [[true, 120], [false, 120], [true, 15]]);
  await s.scheduler.stop();
  await a.close();

  // After a restart the saved schedule is the one in force, whatever RUN_INTERVAL_MINUTES says.
  const settings = loadSettings({ ...SECRETS, RUN_INTERVAL_MINUTES: '45' });
  assert.deepEqual(await effectiveSchedule(h.db, settings), { enabled: true, intervalMinutes: 15, source: 'page', updatedAt: new Date(clock) });
  // A variable value that is not on the list is offered as well, so the starting schedule can always be picked again.
  const s2 = testScheduler({ now: () => clock, intervalMinutes: 15 });
  await tick();
  const b = await startAdmin(h, { runs: s2.scheduler, now: () => new Date(clock), env: { RUN_INTERVAL_MINUTES: '45' } });
  const second = await b.login();
  page = await b.request('GET', '/', { cookie: second.cookie });
  assert.deepEqual(options(page.text).map((o) => o[0]), ['15', '30', '45', '60', '120', '240', '360', '720', '1440']);
  assert.deepEqual(options(page.text).filter((o) => o[1]), [['15', true, 'Every 15 minutes']]);
  assert.equal((await b.request('POST', '/schedule', { cookie: second.cookie, form: { csrf: second.csrf, enabled: '1', interval_minutes: '45' } })).status, 303);
  assert.equal((await getScheduleSettings(h.db)).intervalMinutes, 45);
  assert.equal(s2.scheduler.status().intervalMs, 45 * 60_000);
  await s2.scheduler.stop();
  await b.close();
  await h.cleanup();
});

test('admin schedule: until it is saved on the page, RUN_INTERVAL_MINUTES is the schedule', async () => {
  const h = await makeHarness();
  assert.deepEqual(await effectiveSchedule(h.db, loadSettings({ ...SECRETS })), { enabled: true, intervalMinutes: 30, source: 'variable', updatedAt: null });
  assert.deepEqual(await effectiveSchedule(h.db, loadSettings({ ...SECRETS, RUN_INTERVAL_MINUTES: '45' })), { enabled: true, intervalMinutes: 45, source: 'variable', updatedAt: null });
  const s = testScheduler({ intervalMinutes: 45 });
  await tick();
  const a = await startAdmin(h, { runs: s.scheduler, env: { RUN_INTERVAL_MINUTES: '45' } });
  const { cookie } = await a.login();
  const page = await a.request('GET', '/', { cookie });
  assert.match(page.text, /Scheduled runs are on: every 45 minutes\./);
  assert.match(page.text, /<option value="45" selected>Every 45 minutes<\/option>/);
  await s.scheduler.stop();
  await a.close();
  await h.cleanup();
});
