import { after } from 'node:test';
import { createAdminServer } from '../src/admin/server.js';
import { createAlerter } from '../src/alerts.js';
import { loadSettings } from '../src/config.js';

export const SECRETS = {
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

export async function startAdmin(h, { env = {}, fetchImpl, now, runs = null, mapping = null } = {}) {
  const settings = loadSettings({ ...SECRETS, ALERT_EMAIL_FROM: 'alerts@patchops.example', ...env });
  const sent = [];
  const alerter = createAlerter(settings.alerts, {
    fetchImpl: fetchImpl || (async (url, init) => {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }),
  });
  const admin = createAdminServer({ db: h.db, settings, alerter, logger: h.ctx().logger, now, runs, mapping });
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
