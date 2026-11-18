import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { sendTestAlert } from '../alerts.js';
import { MAX_EMAIL_RECIPIENTS, parseEmailList } from '../config.js';
import { getAlertSettings, getAlertState, lastRun, saveAlertSettings } from '../db/store.js';
import { dashboardPage, loginPage, messagePage } from './views.js';

/**
 * The admin page: alert control only.
 *
 * It can switch alerts on and off, set the email recipients and the repeat
 * interval, send a test alert, and show the last run's status. It has no
 * access to HubSpot: this module does not import the HubSpot client or the
 * run engine, so nothing on the page can write to HubSpot. Secrets (HubSpot
 * token, Resend key, Slack webhook, database URL, admin password) are never
 * rendered and no form field accepts one.
 */

export const MIN_PASSWORD_LENGTH = 12;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPEAT_MINUTES = 10_080;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILED_LOGINS = 10;
const TEST_COOLDOWN_MS = 20_000;
const MAX_SESSIONS = 100;
const CSS = fs.readFileSync(fileURLToPath(new URL('./admin.css', import.meta.url)), 'utf8');

const NOTICES = {
  saved: 'Alert settings saved.',
  signed_out: 'You are signed out.',
};

function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readForm(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new BodyError(415, 'Unsupported form type');
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413, 'Request is too large');
    chunks.push(part);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Removes any configured secret value that might have ended up in a text (for example in an error message). */
function redactor(settings) {
  const secrets = [
    settings.hubspotToken,
    settings.adminPassword,
    settings.databaseUrl,
    settings.alerts?.resendApiKey,
    settings.alerts?.slackWebhookUrl,
  ].filter((value) => typeof value === 'string' && value.length >= 6);
  return (text) => {
    let out = String(text ?? '');
    for (const secret of secrets) out = out.split(secret).join('[hidden]');
    return out;
  };
}

export function createAdminServer({ db, settings, alerter, logger, now = () => new Date() }) {
  const password = settings.adminPassword || '';
  const enabled = password.length >= MIN_PASSWORD_LENGTH;
  const sessionMs = settings.adminSessionHours * 3_600_000;
  const secureCookies = settings.adminInsecureCookie !== true;
  const cookieName = secureCookies ? '__Host-ia_admin' : 'ia_admin';
  const redact = redactor(settings);

  const sessions = new Map();
  let failedLogins = [];
  let lastTestAt = 0;

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      ...(secureCookies ? { 'strict-transport-security': 'max-age=31536000' } : {}),
      ...headers,
    });
    res.end(body);
  }

  const redirect = (res, location, headers = {}) => send(res, 303, '', { location, ...headers });

  function sessionCookie(value, maxAgeSeconds) {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureCookies ? '; Secure' : ''}`;
  }

  function currentSession(req) {
    const id = parseCookies(req.headers.cookie)[cookieName];
    if (!id) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now().getTime()) {
      sessions.delete(id);
      return null;
    }
    return { id, ...session };
  }

  /**
   * A form post must come from this site. Browsers say where a request comes
   * from in Sec-Fetch-Site, which a page cannot set or change; older browsers
   * send only Origin. A client that sends neither is not a browser, and still
   * needs the password (sign-in) or the session's form token (everything else).
   */
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin' || site === 'none';
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      // "null" (a sandboxed or privacy-stripped origin) and anything unreadable.
      return false;
    }
  }

  async function renderDashboard(res, session, { status = 200, notice = null, error = null, form = null } = {}) {
    const [alertSettings, alertState, run] = [
      await getAlertSettings(db),
      await getAlertState(db),
      await lastRun(db, { modes: ['incremental', 'full'] }),
    ];
    if (run?.error) run.error = redact(run.error);
    if (alertState.lastResult) {
      alertState.lastResult = Object.fromEntries(Object.entries(alertState.lastResult).map(([k, v]) => [k, redact(v)]));
    }
    send(res, status, dashboardPage({
      csrf: session.csrf,
      run,
      alertSettings,
      alertState,
      channels: alerter.status(alertSettings.emailRecipients),
      fromAddress: settings.alerts.emailFrom,
      service: { dryRun: settings.dryRun, intervalMinutes: settings.runIntervalMinutes },
      form,
      notice,
      error,
      maxRecipients: MAX_EMAIL_RECIPIENTS,
    }));
  }

  async function handleLogin(req, res) {
    const at = now().getTime();
    failedLogins = failedLogins.filter((t) => at - t < LOGIN_WINDOW_MS);
    if (failedLogins.length >= MAX_FAILED_LOGINS) {
      return send(res, 429, loginPage({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' }), { 'retry-after': '900' });
    }
    const form = await readForm(req);
    if (!sameSecret(form.get('password') || '', password)) {
      failedLogins.push(at);
      logger?.warn('admin sign-in failed', { failedInWindow: failedLogins.length });
      return send(res, 401, loginPage({ error: 'That password is not correct.' }));
    }
    for (const [id, session] of sessions) if (session.expiresAt <= at) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { csrf: crypto.randomBytes(32).toString('base64url'), expiresAt: at + sessionMs });
    logger?.info('admin signed in');
    return redirect(res, '/', { 'set-cookie': sessionCookie(id, Math.floor(sessionMs / 1000)) });
  }

  async function handleSaveAlerts(req, res, session, form) {
    const enabledValue = form.get('enabled') === '1';
    const recipientsText = (form.get('recipients') || '').slice(0, 8000);
    const repeatText = (form.get('repeat_minutes') || '').trim();
    const values = { enabled: enabledValue, recipients: recipientsText, repeatMinutes: repeatText };

    const { addresses, invalid } = parseEmailList(recipientsText);
    const repeat = Number(repeatText);
    let error = null;
    if (invalid.length) error = `Not saved. This does not look like an email address: ${invalid.slice(0, 5).join(', ')}`;
    else if (addresses.length > MAX_EMAIL_RECIPIENTS) error = `Not saved. At most ${MAX_EMAIL_RECIPIENTS} recipients are allowed.`;
    else if (repeatText === '' || !Number.isInteger(repeat) || repeat < 0 || repeat > MAX_REPEAT_MINUTES) {
      error = `Not saved. The repeat interval must be a whole number of minutes from 0 to ${MAX_REPEAT_MINUTES}.`;
    }
    if (error) return renderDashboard(res, session, { status: 400, error, form: values });

    await saveAlertSettings(db, { enabled: enabledValue, emailRecipients: addresses, repeatMinutes: repeat, now: now() });
    logger?.info('alert settings changed in the admin page', { enabled: enabledValue, recipients: addresses.length, repeatMinutes: repeat });
    return redirect(res, '/?notice=saved');
  }

  async function handleTestAlert(req, res, session) {
    const at = now().getTime();
    if (at - lastTestAt < TEST_COOLDOWN_MS) {
      return renderDashboard(res, session, { status: 429, error: 'A test alert was sent a moment ago. Wait a few seconds before sending another.' });
    }
    lastTestAt = at;
    const results = await sendTestAlert({ db, alerter, now });
    const entries = Object.entries(results);
    logger?.info('test alert sent from the admin page', { results });
    if (entries.length === 0) {
      return renderDashboard(res, session, { error: 'Nothing was sent: no alert channel is set up. Email needs the Resend settings and at least one saved recipient.' });
    }
    const text = entries.map(([channel, result]) => `${channel}: ${redact(result)}`).join('; ');
    const failed = entries.some(([, result]) => result !== 'sent');
    return renderDashboard(res, session, failed ? { error: `Test alert: ${text}` } : { notice: `Test alert sent (${text}).` });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://admin.local');
    const path = url.pathname;
    const method = req.method;

    if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
      return send(res, 200, method === 'HEAD' ? '' : '{"status":"ok"}', { 'content-type': 'application/json' });
    }
    if (path === '/assets/admin.css' && method === 'GET') {
      return send(res, 200, CSS, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' });
    }
    if (path === '/robots.txt' && method === 'GET') {
      return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (!enabled) {
      return send(res, 503, messagePage('Admin page is switched off', `Set the ADMIN_PASSWORD service variable (at least ${MIN_PASSWORD_LENGTH} characters) and restart the service to use this page.`));
    }
    if (method !== 'GET' && method !== 'POST') {
      return send(res, 405, messagePage('Not allowed', 'This page does not accept that kind of request.'), { allow: 'GET, POST' });
    }
    if (method === 'POST' && !sameOrigin(req)) {
      return send(res, 403, messagePage('Request refused', 'The form was not sent from this site.'));
    }

    const session = currentSession(req);

    if (path === '/login') {
      if (method === 'GET') return session ? redirect(res, '/') : send(res, 200, loginPage());
      return handleLogin(req, res);
    }
    if (!session) {
      if (method === 'GET' && path === '/') return redirect(res, '/login');
      return send(res, 401, loginPage({ error: 'Sign in to continue.' }));
    }

    if (method === 'GET') {
      if (path !== '/') return send(res, 404, messagePage('Not found', 'There is no page at this address.'));
      return renderDashboard(res, session, { notice: NOTICES[url.searchParams.get('notice')] || null });
    }

    const form = await readForm(req);
    if (!sameSecret(form.get('csrf') || '', session.csrf)) {
      return send(res, 403, messagePage('Request refused', 'The form has expired. Go back, reload the page and try again.'));
    }
    if (path === '/logout') {
      sessions.delete(session.id);
      return redirect(res, '/login', { 'set-cookie': sessionCookie('', 0) });
    }
    if (path === '/alerts') return handleSaveAlerts(req, res, session, form);
    if (path === '/alerts/test') return handleTestAlert(req, res, session);
    return send(res, 404, messagePage('Not found', 'There is no page at this address.'));
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof BodyError) {
        if (!res.headersSent) send(res, err.status, messagePage('Request refused', err.message), { connection: 'close' });
        return;
      }
      logger?.error('admin page request failed', { path: String(req.url).split('?')[0], error: redact(err?.message || String(err)) });
      if (!res.headersSent) send(res, 500, messagePage('Something went wrong', 'The page could not be loaded. The service log has the details.'));
      else res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 60;

  return {
    enabled,
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
