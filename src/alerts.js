import { getAlertSettings, getAlertState, saveAlertState } from './db/store.js';
import { summaryLines } from './report.js';

const SEND_TIMEOUT_MS = 15_000;
export const ALERT_LABEL = 'Industrious association cleanup';

async function readError(response) {
  try {
    const body = await response.json();
    return body?.message || body?.error || '';
  } catch {
    return '';
  }
}

/**
 * Which alert channels have their service variables in place. Email also
 * needs at least one recipient, which is kept in the staging database.
 */
export function channelStatus(alerts, recipients = []) {
  const emailConfigured = Boolean(alerts.resendApiKey && alerts.emailFrom);
  return {
    slack: Boolean(alerts.slackWebhookUrl),
    emailConfigured,
    email: emailConfigured && recipients.length > 0,
  };
}

/**
 * Failure alerting by email (Resend) and/or to a Slack channel (incoming
 * webhook). Either, both or neither can be configured. Sending never throws:
 * a broken alert channel must not break the run.
 */
export function createAlerter(alerts, { fetchImpl = globalThis.fetch, logger } = {}) {
  async function sendSlack({ subject, lines }) {
    const response = await fetchImpl(alerts.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: [`*${subject}*`, ...lines].join('\n') }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
  }

  async function sendEmail({ subject, lines }, recipients) {
    const response = await fetchImpl(`${alerts.resendApiBase}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alerts.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: alerts.emailFrom, to: recipients, subject, text: lines.join('\n') }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await readError(response);
      throw new Error(`Resend returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  return {
    status: (recipients) => channelStatus(alerts, recipients),
    /** Sends to every configured channel. Returns { channel: "sent" | "failed: ..." }; empty when no channel is configured. */
    async send(message, { recipients = [] } = {}) {
      const status = channelStatus(alerts, recipients);
      const channels = [];
      if (status.email) channels.push(['email', () => sendEmail(message, recipients)]);
      if (status.slack) channels.push(['slack', () => sendSlack(message)]);
      const results = {};
      for (const [name, send] of channels) {
        try {
          await send();
          results[name] = 'sent';
        } catch (err) {
          const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || String(err);
          results[name] = `failed: ${reason}`;
          logger?.error('alert could not be sent', { channel: name, error: reason });
        }
      }
      return results;
    },
  };
}

/**
 * Decides when a finished run should raise an alert: on the first failing
 * run, then at most once per repeat interval while runs keep failing, and
 * once more when a run succeeds again.
 *
 * The on/off switch, recipients and repeat interval come from the staging
 * database (edited in the admin page), and so does the "currently failing"
 * state, so a restart does not repeat or lose an alert. If the database
 * cannot be read (which may be the very failure to report), the values from
 * the service variables are used instead.
 */
export function createRunNotifier({ db, alerter, defaults = {}, now = () => new Date(), label = ALERT_LABEL, logger }) {
  const memory = { failing: false, lastAlertAt: null };

  async function load() {
    try {
      const [settings, state] = [await getAlertSettings(db), await getAlertState(db)];
      return { settings, state, fromDatabase: true };
    } catch (err) {
      logger?.warn('alert settings could not be read from the staging database; using the service variables', { error: err?.message || String(err) });
      return {
        settings: { enabled: true, emailRecipients: defaults.emailTo || [], repeatMinutes: defaults.minRepeatMinutes ?? 60 },
        state: { ...memory },
        fromDatabase: false,
      };
    }
  }

  async function store(state, extra, fromDatabase) {
    memory.failing = state.failing;
    memory.lastAlertAt = state.lastAlertAt;
    if (!fromDatabase) return;
    try {
      await saveAlertState(db, { ...state, ...extra });
    } catch (err) {
      logger?.warn('alert state could not be saved', { error: err?.message || String(err) });
    }
  }

  return {
    async afterRun(summary) {
      if (summary.status === 'skipped') return null;
      const { settings, state, fromDatabase } = await load();
      const bad = summary.status !== 'ok';
      const dry = summary.dryRun ? ' (dry run)' : '';
      const at = now();

      if (!settings.enabled) {
        // Keep track of the state so switching alerts back on behaves sensibly.
        await store({ failing: bad, lastAlertAt: null }, {}, fromDatabase);
        return null;
      }
      if (bad) {
        const last = state.lastAlertAt ? new Date(state.lastAlertAt).getTime() : null;
        const due = !state.failing || last === null || at.getTime() - last >= settings.repeatMinutes * 60_000;
        if (!due) {
          await store({ failing: true, lastAlertAt: state.lastAlertAt }, {}, fromDatabase);
          return null;
        }
        const what = summary.status === 'failed' ? 'run FAILED' : 'run completed with errors';
        const subject = `${label}: ${what}${dry}`;
        const results = await alerter.send({ subject, lines: summaryLines(summary) }, { recipients: settings.emailRecipients });
        await store({ failing: true, lastAlertAt: at }, { lastSentAt: at, lastSubject: subject, lastResult: results }, fromDatabase);
        return results;
      }
      if (state.failing) {
        const subject = `${label}: recovered${dry}`;
        const results = await alerter.send({ subject, lines: summaryLines(summary) }, { recipients: settings.emailRecipients });
        await store({ failing: false, lastAlertAt: null }, { lastSentAt: at, lastSubject: subject, lastResult: results }, fromDatabase);
        return results;
      }
      return null;
    },
  };
}

/** Sends a test message to the configured channels, whether or not alerts are switched on. */
export async function sendTestAlert({ db, alerter, now = () => new Date(), label = ALERT_LABEL }) {
  const settings = await getAlertSettings(db);
  const state = await getAlertState(db);
  const subject = `${label}: test alert`;
  const lines = [
    'This is a test alert sent from the admin page.',
    'Nothing is wrong. Run failures will be reported to this address or channel.',
    `Sent: ${now().toISOString()}`,
  ];
  const results = await alerter.send({ subject, lines }, { recipients: settings.emailRecipients });
  await saveAlertState(db, { failing: state.failing, lastAlertAt: state.lastAlertAt, lastSentAt: now(), lastSubject: subject, lastResult: results });
  return results;
}
