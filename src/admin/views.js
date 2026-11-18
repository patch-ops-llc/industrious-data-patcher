const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function when(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body>
${body}
</body>
</html>
`;
}

export function loginPage({ error = '' } = {}) {
  return page('Sign in', `<main class="narrow">
<h1>Industrious association cleanup</h1>
<p class="muted">Alert settings</p>
${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login" class="card">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>
</form>
</main>`);
}

export function messagePage(title, text) {
  return page(title, `<main class="narrow">
<h1>${esc(title)}</h1>
<p>${esc(text)}</p>
</main>`);
}

const STATUS = {
  ok: ['good', 'OK'],
  completed_with_errors: ['warn', 'Completed with errors'],
  failed: ['bad', 'Failed'],
  running: ['info', 'Running'],
  skipped: ['info', 'Skipped'],
};

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
  const rules = (summary.rules || []).map((rule) => {
    const filled = dry ? rule.planned : (rule.created || 0) + (rule.createdUnverified || 0);
    const held = (rule.multipleTargets || 0) + (rule.associatedElsewhere || 0);
    return `<tr><td>${esc(rule.label)}</td><td class="num">${esc(rule.sources)}</td><td class="num">${esc(filled)}</td><td class="num">${esc(rule.noTarget)}</td><td class="num">${esc(held)}</td><td class="num">${esc(rule.failed)}</td></tr>`;
  }).join('\n');
  const deal = summary.dealAmount
    ? `<p>Deal amounts: ${esc(dry ? summary.dealAmount.planned : summary.dealAmount.updated)} ${dry ? 'would be updated' : 'updated'}, ${esc(summary.dealAmount.heldCount ?? 0)} held for review, ${esc(summary.dealAmount.failed)} failed.</p>`
    : '';
  return `<section class="card">
<h2>Last run</h2>
<p><span class="badge ${tone}">${esc(label)}</span> <span class="badge ${dry ? 'info' : 'live'}">${dry ? 'Dry run' : 'Live'}</span></p>
<dl>
<dt>Type</dt><dd>${run.mode === 'full' ? 'Reconciliation' : 'Scheduled run'}</dd>
<dt>Started</dt><dd>${esc(when(run.startedAt))}</dd>
<dt>Finished</dt><dd>${run.finishedAt ? esc(when(run.finishedAt)) : 'Not finished'}</dd>
<dt>Run ID</dt><dd><code>${esc(run.runId)}</code></dd>
${run.error ? `<dt>Error</dt><dd class="error-text">${esc(run.error)}</dd>` : ''}
</dl>
${rules ? `<div class="table-wrap"><table>
<thead><tr><th>Association</th><th class="num">Checked</th><th class="num">${dry ? 'Would fill' : 'Filled'}</th><th class="num">No match</th><th class="num">Held for review</th><th class="num">Failed</th></tr></thead>
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
<li><span class="dot ${email[0]}"></span><strong>Email (Resend)</strong> ${esc(email[1])}</li>
<li><span class="dot ${slack[0]}"></span><strong>Slack</strong> ${esc(slack[1])}</li>
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

export function dashboardPage({ csrf, run, alertSettings, alertState, channels, fromAddress, service, form = null, notice = null, error = null, maxRecipients }) {
  const values = form || {
    enabled: alertSettings.enabled,
    recipients: alertSettings.emailRecipients.join('\n'),
    repeatMinutes: String(alertSettings.repeatMinutes),
  };
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  return page('Alert settings', `<header class="top">
<h1>Industrious association cleanup</h1>
<form method="post" action="/logout">${hidden}<button type="submit" class="link">Sign out</button></form>
</header>
<main>
${notice ? `<p class="notice good" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="notice bad" role="alert">${esc(error)}</p>` : ''}
${lastRunCard(run)}
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
<section class="card">
<h2>Service</h2>
<dl>
<dt>Mode</dt><dd>${service.dryRun ? 'Dry run: scheduled runs change nothing in HubSpot' : 'Live: scheduled runs write to HubSpot'}</dd>
<dt>Schedule</dt><dd>Every ${esc(service.intervalMinutes)} minutes</dd>
</dl>
<p class="hint">The mode, the schedule, the field mappings and all keys are service settings and cannot be changed here.</p>
</section>
</main>`);
}
