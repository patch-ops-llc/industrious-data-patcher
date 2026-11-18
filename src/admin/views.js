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

export function when(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** 29838 becomes 29,838. Anything that is not a whole number is shown as it is. */
export function count(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isInteger(number)) return esc(value);
  return number.toLocaleString('en-US');
}

const LOGO = '<img class="logo" src="/assets/logo.svg" alt="Industrious Group" width="193" height="40">';

function page(title, body, { bodyClass = '', refresh = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#29292b">${refresh ? `
<meta http-equiv="refresh" content="${esc(refresh.seconds)}; url=${esc(refresh.url)}">` : ''}
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

/**
 * The signed-in pages: header with the logo and sign out, the title band with
 * the mode the service is in, then the page's own content. nav is the list of
 * sections to link to ([{ href, label, active }]); none when there is only one.
 */
export function shell({ title, eyebrow = 'Epicor and HubSpot', heading, sub, csrf, dryRun, nav = [], body, refresh = null }) {
  const mode = dryRun
    ? ['dry', 'Dry run', 'Runs change nothing in HubSpot']
    : ['live', 'Live', 'Runs write to HubSpot'];
  const links = nav.length
    ? `<nav class="nav" aria-label="Sections">${nav.map((item) => `<a href="${esc(item.href)}"${item.active ? ' class="active" aria-current="page"' : ''}>${esc(item.label)}</a>`).join('')}</nav>`
    : '';
  return page(title, `<header class="top">
<div class="wrap top-inner">
${LOGO}
${links}
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="quiet">Sign out</button></form>
</div>
</header>
<div class="hero">
<div class="wrap hero-inner">
<div>
<p class="eyebrow">${esc(eyebrow)}</p>
<h1>${esc(heading)}</h1>
<p class="hero-sub">${esc(sub)}</p>
</div>
<p class="mode ${mode[0]}"><strong>${mode[1]}</strong><span>${mode[2]}</span></p>
</div>
</div>
<main class="wrap">
${body}
</main>
<footer class="foot">
<div class="wrap">Industrious Group &middot; HubSpot association cleanup</div>
</footer>`, { refresh });
}

/** The sections of the admin page. Review is only there when the service handed the page its mapping. */
export function sections(active, review) {
  if (!review) return [];
  return [
    { href: '/', label: 'Overview', active: active === 'overview' },
    { href: '/review', label: 'Review', active: active === 'review' },
  ];
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
<p class="muted">Run status, schedule and alerts for the Epicor and HubSpot association cleanup.</p>
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

export const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

const RELOAD_SECONDS = 5;

/** Share linked, to one decimal and rounded down, so 100% is only shown when nothing is missing. */
function share(linked, of) {
  if (!of) return null;
  if (linked >= of) return '100%';
  if (linked <= 0) return '0%';
  return `${(Math.floor((linked / of) * 1000) / 10).toFixed(1)}%`;
}

function healthRow(group, dryRun, review) {
  const n = (value) => Math.max(0, Number(value) || 0);
  const [records, withKey, linked] = [n(group.records), n(group.withKey), n(group.linked)];
  const percent = share(linked, withKey);
  const complete = withKey > 0 && linked >= withKey;
  const width = withKey ? Math.min(100, (linked / withKey) * 100).toFixed(2) : '0';
  const to = esc(group.toLabel);
  // The records behind a chip are listed on the Review page, under this pair of record types.
  const listed = review ? `/review#${esc(`${group.from}-${group.to}`.replace(/[^A-Za-z0-9_-]/g, ''))}` : null;
  const rest = [
    [n(group.pending), 'warn', dryRun ? 'would be linked by a live run' : 'not linked yet', false],
    [n(group.failed), 'bad', 'failed', true],
    [n(group.held), 'warn', 'held for review', true],
    [n(group.noMatch), 'warn', `${n(group.noMatch) === 1 ? 'matches' : 'match'} no ${to}`, true],
    [n(group.noKey), 'quiet', n(group.noKey) === 1 ? 'has no ID' : 'have no ID', true],
  ].filter(([value]) => value > 0).map(([value, tone, text, onReview]) => {
    const inner = `<strong>${count(value)}</strong> ${text}`;
    return `<li class="chip ${tone}">${listed && onReview ? `<a href="${listed}">${inner}</a>` : inner}</li>`;
  });
  if (complete) rest.unshift(`<li class="chip good">${n(group.noKey) ? 'Every record with an ID is linked' : 'Every record is linked'}</li>`);
  if (!records) rest.push('<li class="chip quiet">No records yet</li>');
  const chips = rest.join('\n');
  const keys = (group.keys || []).map((key) => `<code>${esc(key)}</code>`).join(' or ');
  return `<li class="health-row">
<div class="health-what">
<p class="health-name">${esc(group.fromLabel)} <span class="health-to">to</span> ${to}</p>
<p class="hint">${plural(records, 'record', 'records')}${n(group.noKey) ? `, ${count(withKey)} with an ID` : ''}${keys ? `. Matched on ${keys}.` : '.'}</p>
</div>
<div class="health-figure">
<p class="health-share${complete ? ' good' : ''}">${percent ?? '&ndash;'}</p>
<p class="health-count"><strong>${count(linked)}</strong> of ${count(withKey)} linked</p>
</div>
<svg class="health-bar" role="img" aria-label="${percent ? `${percent} linked` : 'Nothing to link'}" width="100%" height="8" focusable="false"><rect class="track" width="100%" height="8"></rect><rect class="fill${complete ? ' good' : ''}" width="${width}%" height="8"></rect></svg>
<ul class="chips">
${chips}
</ul>
</li>`;
}

/** How many records of each type are linked to the record their ID matches, as the last finished run found it. */
function healthCard(health, review) {
  const groups = Array.isArray(health?.groups) ? health.groups : [];
  if (!groups.length) {
    return `<section class="card">
<h2>Link health</h2>
<p class="muted">How many records of each type are linked to the record their ID matches. Every run works this out; the figures appear here when the next run has finished.</p>
</section>`;
  }
  const kind = health.mode === 'full' ? 'reconciliation' : 'sync';
  const caveat = health.dryRun
    ? ' That was a dry run, so nothing was linked by it.'
    : health.limit ? ` That run was limited to ${esc(health.limit)} records per association.` : '';
  return `<section class="card">
<h2>Link health</h2>
<p class="muted">How many records of each type are linked in HubSpot to the record their ID matches. As of the ${kind} finished <span class="nowrap">${esc(when(health.finishedAt))}</span>.${caveat}</p>
<ul class="health">
${groups.map((group) => healthRow(group, health.dryRun, review)).join('\n')}
</ul>
<p class="hint">The percentage is the share of records that carry an ID. Records without an ID cannot be matched and are listed separately.${review ? ' The records that are held, unmatched or without an ID are listed under <a href="/review">Review</a>.' : ''}</p>
</section>`;
}

/** Sync now, and when the next scheduled run is. Empty when the page has no run control. */
function syncBlock(sync, hidden) {
  if (!sync) return '';
  const effect = sync.dryRun
    ? 'Dry run: reads from HubSpot, changes nothing.'
    : 'Live: writes to HubSpot, like a scheduled run.';
  if (sync.running) {
    const what = sync.runningTrigger === 'manual' ? 'A run started here' : 'A scheduled run';
    return `<div class="sync">
${sync.watching ? '' : '<form method="get" action="/"><input type="hidden" name="watch" value="run"><button type="submit" class="secondary">Follow this run</button></form>'}
<p class="sync-state"><strong>${what} is in progress</strong>, <span class="nowrap">started ${esc(when(sync.runningSince))}.</span></p>
<p class="hint">${sync.watching ? `This page reloads every ${RELOAD_SECONDS} seconds until the run finishes.` : 'Sync now is available again when it finishes.'}</p>
</div>`;
  }
  let next;
  if (!sync.enabled) next = '<strong>Scheduled runs are paused.</strong>';
  else if (sync.nextRunAt) next = `Next scheduled run: <span class="nowrap">${esc(when(sync.nextRunAt))}</span>`;
  else next = 'Scheduled runs are on.';
  return `<div class="sync">
<form method="post" action="/run">${hidden}<button type="submit">Sync now</button></form>
<p class="sync-state">${next}</p>
<p class="hint">${effect}</p>
</div>`;
}

function lastRunCard(run, sync, hidden, review) {
  const controls = syncBlock(sync, hidden);
  if (!run) {
    return `<section class="card">
<div class="run-head">
<div>
<h2>Last run</h2>
<p class="muted">No run has been recorded yet.</p>
</div>
${controls}
</div>
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

  const kind = run.mode === 'full' ? 'Reconciliation' : 'Sync';
  const timing = run.finishedAt ? `finished ${when(run.finishedAt)}` : `started ${when(run.startedAt)}, not finished`;
  return `<section class="card">
<div class="run-head">
<div>
<h2>Last run</h2>
<p class="run-state"><span class="badge ${tone}">${esc(label)}</span> <span class="badge ${dry ? 'info' : 'live'}">${dry ? 'Dry run' : 'Live'}</span> <span class="run-when">${kind}, ${esc(timing)}</span></p>
</div>
${controls}
</div>
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
${review && (rules || deal) ? '<p class="hint">The records held for review and the records without a match are listed under <a href="/review">Review</a>.</p>' : ''}
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

function scheduleCard(sync, hidden) {
  if (!sync) return '';
  const state = sync.enabled
    ? `Scheduled runs are on: ${esc(sync.intervalLabel.toLowerCase())}.`
    : '<strong>Scheduled runs are paused.</strong> Runs only start with Sync now.';
  const source = sync.source === 'page'
    ? `Set on this page on ${esc(when(sync.updatedAt))}. The RUN_INTERVAL_MINUTES service variable no longer applies.`
    : 'This is still the starting schedule, from the RUN_INTERVAL_MINUTES service variable.';
  const options = sync.choices
    .map((choice) => `<option value="${esc(choice.minutes)}"${choice.minutes === sync.intervalMinutes ? ' selected' : ''}>${esc(choice.label)}</option>`)
    .join('\n');
  return `<section class="card">
<h2>Schedule</h2>
<p class="muted">${state}</p>
<form method="post" action="/schedule">
${hidden}
<label class="check"><input type="checkbox" name="enabled" value="1"${sync.enabled ? ' checked' : ''}> Run on a schedule</label>
<label for="interval_minutes">How often</label>
<select id="interval_minutes" name="interval_minutes">
${options}
</select>
<p class="hint">Counted from the start of one run to the start of the next. A change takes effect straight away.</p>
<button type="submit">Save schedule</button>
</form>
<p class="hint">${source}</p>
</section>`;
}

export function dashboardPage({ csrf, run, health = null, review = false, alertSettings, alertState, channels, fromAddress, service, password, sync = null, form = null, notice = null, error = null, maxRecipients }) {
  const values = form || {
    enabled: alertSettings.enabled,
    recipients: alertSettings.emailRecipients.join('\n'),
    repeatMinutes: String(alertSettings.repeatMinutes),
  };
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const refresh = sync?.running && sync.watching ? { seconds: RELOAD_SECONDS, url: '/?watch=run' } : null;
  const body = `${notice ? `<p class="notice good" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ''}
${refresh ? `<p class="notice info" role="status">A run is in progress. This page reloads every ${RELOAD_SECONDS} seconds until it finishes.</p>` : ''}
${healthCard(health, review)}
${lastRunCard(run, sync, hidden, review)}
<div class="columns">
<div class="column">
${scheduleCard(sync, hidden)}
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
</div>
<div class="column">
<section class="card">
<h2>Test alert</h2>
<p class="muted">Sends a test message to the saved recipients and to Slack, whether or not alerts are switched on.</p>
${lastSent(alertState)}
<form method="post" action="/alerts/test">${hidden}<button type="submit" class="secondary">Send test alert</button></form>
</section>
${passwordCard(password, hidden)}
<section class="card">
<h2>Service</h2>
<dl>
<dt>Mode</dt><dd>${service.dryRun ? 'Dry run: runs change nothing in HubSpot' : 'Live: runs write to HubSpot'}</dd>${sync ? '' : `
<dt>Schedule</dt><dd>Every ${esc(service.intervalMinutes)} minutes</dd>`}
</dl>
<p class="hint">${sync
    ? 'The mode, the field mappings and all keys are service settings and cannot be changed here.'
    : 'The mode, the schedule, the field mappings and all keys are service settings and cannot be changed here.'}</p>
</section>
</div>
</div>`;
  return shell({
    title: 'Association cleanup',
    heading: 'Association cleanup',
    sub: sync ? 'Link health, runs, schedule and alerts' : 'Link health, run status and alerts',
    csrf,
    dryRun: service.dryRun,
    nav: sections('overview', review),
    body,
    refresh,
  });
}
