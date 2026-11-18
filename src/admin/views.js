import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Changes whenever the stylesheet does, so a browser never pairs a new page with an old stylesheet.
const STYLE_VERSION = crypto.createHash('sha256')
  .update(fs.readFileSync(fileURLToPath(new URL('./admin.css', import.meta.url))))
  .digest('hex')
  .slice(0, 12);

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function when(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** 29838 becomes 29,838. Anything that is not a whole number is shown as it is. */
function count(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isInteger(number)) return esc(value);
  return number.toLocaleString('en-US');
}

const LOGO = '<img class="logo" src="/assets/logo.svg" alt="Industrious Group" width="193" height="40">';

function page(title, body, { bodyClass = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#29292b">
<title>${esc(title)} | Industrious Group</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/admin.css?v=${STYLE_VERSION}">
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
</body>
</html>
`;
}

function panelPage(title, inner) {
  return page(title, `<main class="panel-main">
<div class="panel">
${LOGO}
${inner}
</div>
<p class="panel-foot">Industrious Group &middot; HubSpot association cleanup</p>
</main>`, { bodyClass: 'dark' });
}

export function loginPage({ error = '' } = {}) {
  return panelPage('Sign in', `<p class="eyebrow">Association cleanup</p>
<h1>Sign in</h1>
<p class="muted">Alert settings and run status for the Epicor and HubSpot association cleanup.</p>
${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit" class="wide">Sign in</button>
</form>`);
}

export function messagePage(title, text) {
  return panelPage(title, `<p class="eyebrow">Association cleanup</p>
<h1>${esc(title)}</h1>
<p>${esc(text)}</p>`);
}

const STATUS = {
  ok: ['good', 'OK'],
  completed_with_errors: ['warn', 'Completed with errors'],
  failed: ['bad', 'Failed'],
  running: ['info', 'Running'],
  skipped: ['info', 'Skipped'],
};

function stat(label, value, note, tone = '') {
  return `<div class="stat${tone ? ` ${tone}` : ''}">
<p class="stat-label">${esc(label)}</p>
<p class="stat-value">${count(value)}</p>
<p class="stat-note">${esc(note)}</p>
</div>`;
}

const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

function lastRunCard(run) {
  if (!run) {
    return `<section class="card">
<h2>Last run</h2>
<p class="muted">No run has been recorded yet.</p>
</section>`;
  }
  const [tone, label] = STATUS[run.status] || ['info', run.status];
  const summary = run.summary || {};
  const dry = run.dryRun;
  const fillLabel = dry ? 'Would fill' : 'Filled';
  const totals = { filled: 0, noMatch: 0, held: 0, failed: 0 };
  const rules = (summary.rules || []).map((rule) => {
    const filled = dry ? rule.planned : (rule.created || 0) + (rule.createdUnverified || 0);
    const held = (rule.multipleTargets || 0) + (rule.associatedElsewhere || 0);
    totals.filled += Number(filled) || 0;
    totals.noMatch += Number(rule.noTarget) || 0;
    totals.held += held;
    totals.failed += Number(rule.failed) || 0;
    return `<tr><td>${esc(rule.label)}</td><td class="num" data-label="Checked">${count(rule.sources)}</td><td class="num" data-label="${fillLabel}">${count(filled)}</td><td class="num" data-label="No match">${count(rule.noTarget)}</td><td class="num" data-label="Held for review">${count(held)}</td><td class="num" data-label="Failed">${count(rule.failed)}</td></tr>`;
  }).join('\n');

  const dealAmount = summary.dealAmount;
  // In a dry run the deal amounts that would move once the planned lines are linked are worked out separately.
  const projection = dry ? dealAmount?.projection : null;
  const dealsHeld = (Number(dealAmount?.heldCount) || 0) + (Number(projection?.heldCount) || 0);
  const dealsFailed = Number(dealAmount?.failed) || 0;
  const deal = dealAmount
    ? `<p class="deal-line">Deal amounts: ${count(dry ? dealAmount.planned : dealAmount.updated)} ${dry ? 'would be updated' : 'updated'}, ${count(dealAmount.heldCount ?? 0)} held for review, ${count(dealAmount.failed)} failed.</p>${projection
      ? `\n<p class="deal-line">Once the planned lines are linked: ${count(projection.wouldUpdate)} deal amounts would be updated, ${count(projection.heldCount)} held for review, ${count(projection.closedSkippedCount ?? 0)} left alone because the deal is closed.</p>`
      : ''}`
    : '';

  const held = totals.held + dealsHeld;
  const failed = totals.failed + dealsFailed;
  const stats = summary.rules?.length
    ? `<div class="stats">
${stat(fillLabel, totals.filled, totals.filled === 1 ? 'association' : 'associations')}
${stat('Held for review', held, `${plural(totals.held, 'association', 'associations')}, ${plural(dealsHeld, 'deal amount', 'deal amounts')}`, held ? 'warn' : '')}
${stat('No match', totals.noMatch, totals.noMatch === 1 ? 'record without a match' : 'records without a match')}
${stat('Failed', failed, failed ? 'see the service log' : 'nothing failed', failed ? 'bad' : '')}
</div>`
    : '';

  const kind = run.mode === 'full' ? 'Reconciliation' : 'Scheduled run';
  const timing = run.finishedAt ? `finished ${when(run.finishedAt)}` : `started ${when(run.startedAt)}, not finished`;
  return `<section class="card">
<h2>Last run</h2>
<p class="run-state"><span class="badge ${tone}">${esc(label)}</span> <span class="badge ${dry ? 'info' : 'live'}">${dry ? 'Dry run' : 'Live'}</span> <span class="run-when">${kind}, ${esc(timing)}</span></p>
${stats}
<dl class="wide">
<dt>Type</dt><dd>${kind}</dd>
<dt>Started</dt><dd>${esc(when(run.startedAt))}</dd>
<dt>Finished</dt><dd>${run.finishedAt ? esc(when(run.finishedAt)) : 'Not finished'}</dd>
<dt>Run ID</dt><dd><code>${esc(run.runId)}</code></dd>
${run.error ? `<dt>Error</dt><dd class="error-text">${esc(run.error)}</dd>` : ''}
</dl>
${rules ? `<div class="table-wrap"><table class="rules">
<thead><tr><th>Association</th><th class="num">Checked</th><th class="num">${fillLabel}</th><th class="num">No match</th><th class="num">Held for review</th><th class="num">Failed</th></tr></thead>
<tbody>
${rules}
</tbody>
</table></div>` : ''}
${deal}
</section>`;
}

function channelLines(channels, fromAddress) {
  let email;
  if (!channels.emailConfigured) email = ['off', 'Not set up. The Resend API key and the sender address are set as service variables.'];
  else if (!channels.email) email = ['off', 'Set up, but there are no recipients yet.'];
  else email = ['on', `Ready. Sent from ${fromAddress}.`];
  const slack = channels.slack ? ['on', 'Ready. The webhook is set as a service variable.'] : ['off', 'Not set up.'];
  return `<ul class="channels">
<li><span class="dot ${email[0]}"></span><span><strong>Email (Resend)</strong> ${esc(email[1])}</span></li>
<li><span class="dot ${slack[0]}"></span><span><strong>Slack</strong> ${esc(slack[1])}</span></li>
</ul>`;
}

function lastSent(state) {
  if (!state.lastSentAt) return '<p class="muted">No alert has been sent yet.</p>';
  const results = Object.entries(state.lastResult || {});
  const detail = results.length
    ? results.map(([channel, result]) => `${esc(channel)}: ${esc(result)}`).join('; ')
    : 'no channel was set up, so nothing was sent';
  return `<p class="muted">Last message: ${esc(state.lastSubject || '')}, ${esc(when(state.lastSentAt))} (${detail}).</p>`;
}

function passwordCard(password, hidden) {
  const source = password.changedAt
    ? `Set on this page on ${esc(when(password.changedAt))}. The ADMIN_PASSWORD service variable no longer signs in.`
    : 'This is still the starting password, the ADMIN_PASSWORD service variable.';
  return `<section class="card">
<h2>Password</h2>
<p class="muted">${source}</p>
<form method="post" action="/password">
${hidden}
<label for="current_password">Current password</label>
<input id="current_password" name="current_password" type="password" autocomplete="current-password" required>
<label for="new_password">New password</label>
<input id="new_password" name="new_password" type="password" autocomplete="new-password" minlength="${esc(password.minLength)}" maxlength="${esc(password.maxLength)}" required>
<p class="hint">At least ${esc(password.minLength)} characters.</p>
<label for="confirm_password">Confirm new password</label>
<input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" minlength="${esc(password.minLength)}" maxlength="${esc(password.maxLength)}" required>
<button type="submit">Change password</button>
</form>
<p class="hint">Changing the password signs out every other session. If it is forgotten, give the ADMIN_PASSWORD service variable a new value in Railway: the service restarts and that value is the password again.</p>
</section>`;
}

export function dashboardPage({ csrf, run, alertSettings, alertState, channels, fromAddress, service, password, form = null, notice = null, error = null, maxRecipients }) {
  const values = form || {
    enabled: alertSettings.enabled,
    recipients: alertSettings.emailRecipients.join('\n'),
    repeatMinutes: String(alertSettings.repeatMinutes),
  };
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const mode = service.dryRun
    ? ['dry', 'Dry run', 'Scheduled runs change nothing in HubSpot']
    : ['live', 'Live', 'Scheduled runs write to HubSpot'];
  return page('Association cleanup', `<header class="top">
<div class="wrap top-inner">
${LOGO}
<form method="post" action="/logout">${hidden}<button type="submit" class="quiet">Sign out</button></form>
</div>
</header>
<div class="hero">
<div class="wrap hero-inner">
<div>
<p class="eyebrow">Epicor and HubSpot</p>
<h1>Association cleanup</h1>
<p class="hero-sub">Alert settings and run status</p>
</div>
<p class="mode ${mode[0]}"><strong>${mode[1]}</strong><span>${mode[2]}</span></p>
</div>
</div>
<main class="wrap">
${notice ? `<p class="notice good" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ''}
${lastRunCard(run)}
<div class="columns">
<div class="column">
<section class="card">
<h2>Alerts</h2>
<p class="muted">An alert goes out when a run fails or finishes with errors, again at most once per repeat interval while runs keep failing, and once more when a run succeeds again.${alertState.failing ? ' <strong>Runs are currently failing.</strong>' : ''}</p>
${channelLines(channels, fromAddress)}
<form method="post" action="/alerts">
${hidden}
<label class="check"><input type="checkbox" name="enabled" value="1"${values.enabled ? ' checked' : ''}> Send alerts</label>
<label for="recipients">Email recipients</label>
<textarea id="recipients" name="recipients" rows="4" spellcheck="false" placeholder="name@example.com">${esc(values.recipients)}</textarea>
<p class="hint">One address per line, or separated by commas. Up to ${esc(maxRecipients)}.</p>
<label for="repeat_minutes">Repeat interval (minutes)</label>
<input id="repeat_minutes" name="repeat_minutes" type="number" min="0" max="10080" step="1" required value="${esc(values.repeatMinutes)}">
<p class="hint">While runs keep failing, send at most one alert per this many minutes. 0 sends one for every failing run.</p>
<button type="submit">Save alert settings</button>
</form>
</section>
<section class="card">
<h2>Test alert</h2>
<p class="muted">Sends a test message to the saved recipients and to Slack, whether or not alerts are switched on.</p>
${lastSent(alertState)}
<form method="post" action="/alerts/test">${hidden}<button type="submit" class="secondary">Send test alert</button></form>
</section>
</div>
<div class="column">
${passwordCard(password, hidden)}
<section class="card">
<h2>Service</h2>
<dl>
<dt>Mode</dt><dd>${service.dryRun ? 'Dry run: scheduled runs change nothing in HubSpot' : 'Live: scheduled runs write to HubSpot'}</dd>
<dt>Schedule</dt><dd>Every ${esc(service.intervalMinutes)} minutes</dd>
</dl>
<p class="hint">The mode, the schedule, the field mappings and all keys are service settings and cannot be changed here.</p>
</section>
</div>
</div>
</main>
<footer class="foot">
<div class="wrap">Industrious Group &middot; HubSpot association cleanup</div>
</footer>`);
}
