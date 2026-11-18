import { recordUrl } from '../review.js';
import { count, esc, plural, sections, shell, when } from './views.js';

/**
 * The Review section of the admin page: the records a run held for review or
 * could not match, and the deal amount changes the guard holds. Everything
 * here is read from the staging database. The one thing that can be changed is
 * releasing a held deal amount change, which is recorded in the staging
 * database and acted on by the service's next run.
 */

const REASONS = {
  multiple_targets: {
    column: 'Held for review',
    title: 'Held for review: more than one match',
    explain: (rule) => `The ID on each of these matches more than one ${rule.to.label}, so the service does not pick one. Make the ID unique on the ${rule.to.label} records, or link the right one by hand; the next run takes it off this list.`,
  },
  associated_elsewhere: {
    column: 'Linked elsewhere',
    title: 'Held for review: linked to a different record',
    explain: (rule) => `Each of these is already linked to a different ${rule.to.label} record than the one its ID matches, so the service leaves it alone.`,
  },
  no_target: {
    column: 'No match',
    title: 'No match',
    explain: (rule) => `The ID on each of these matches no ${rule.to.label}. The next run links a record as soon as a matching ${rule.to.label} record exists.`,
  },
  missing_key: {
    column: 'No ID',
    title: 'No ID',
    explain: (rule) => `Each of these has no value in ${rule.keys.join(' and ') || 'its ID field'}, so there is nothing to match on.`,
  },
  failed: {
    column: 'Failed',
    title: 'Failed',
    explain: () => 'HubSpot refused the association for each of these. The error is shown with the record; the next run tries again.',
  },
};

export const reasonTitle = (status) => REASONS[status]?.title ?? status;

/** A record ID, as a link that opens the record in HubSpot when the portal ID and the object type are known. */
function recordLink(catalog, object, id) {
  const url = recordUrl(catalog.portalId, object?.objectType, id);
  return url ? `<a class="ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(id)}</a>` : esc(id);
}

/**
 * The reason text of a held association, with the record IDs it names turned
 * into links. Only IDs that directly follow the name of the record type, or
 * "key matches", are linked; everything else is shown as written.
 */
function detailWithLinks(catalog, rule, detail) {
  const text = String(detail ?? '');
  const label = rule.to.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`((?:${label}|key matches) )(\\d+(?:, \\d+)*)`, 'g');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += esc(text.slice(last, match.index) + match[1]);
    out += match[2].split(', ').map((id) => recordLink(catalog, rule.to, id)).join(', ');
    last = match.index + match[0].length;
  }
  return out + esc(text.slice(last));
}

/** "quote_number=Q-1" is shown as Q-1 when the rule matches on that one property. */
function keyValue(rule, key) {
  const text = String(key ?? '');
  if (rule.keys.length === 1 && text.startsWith(`${rule.keys[0]}=`)) return text.slice(rule.keys[0].length + 1);
  return text;
}

function money(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '<span class="muted">none</span>';
  const number = Number(text);
  if (!Number.isFinite(number)) return esc(text);
  return esc(number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

function difference(from, to) {
  const before = Number(String(from ?? '').trim() || 0);
  const after = Number(String(to ?? '').trim());
  if (!Number.isFinite(before) || !Number.isFinite(after) || String(to ?? '').trim() === '') return '';
  const delta = Math.round((after - before) * 100) / 100;
  const shown = Math.abs(delta).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${delta < 0 ? '&minus;' : '+'}${esc(shown)}`;
}

export function holdReasons(catalog, reasons) {
  const guard = catalog.dealAmount?.guard || {};
  const text = {
    sets_deal_to_zero: 'Would set the deal amount to 0',
    change_over_threshold: `Moves the deal amount by more than ${Number(guard.largeChangeThreshold).toLocaleString('en-US')}`,
    change_over_percent: `Changes the deal amount by more than ${guard.percentChangeThreshold}%`,
  };
  return (Array.isArray(reasons) ? reasons : []).map((reason) => text[reason] ?? String(reason)).join('; ');
}

function notices(notice, error) {
  return `${notice ? `<p class="notice good" role="status">${esc(notice)}</p>\n` : ''}${error ? `<p class="notice bad" role="alert">${esc(error)}</p>\n` : ''}`;
}

function crumbs(items) {
  return `<p class="crumbs">${items.map((item) => (item.href ? `<a href="${esc(item.href)}">${esc(item.label)}</a>` : `<span>${esc(item.label)}</span>`)).join(' <span class="sep" aria-hidden="true">/</span> ')}</p>`;
}

function pager(base, pageNumber, pageCount, total, pageSize) {
  if (!total) return '';
  const first = (pageNumber - 1) * pageSize + 1;
  const last = Math.min(total, pageNumber * pageSize);
  const link = (n, label) => `<a href="${esc(`${base}${base.includes('?') ? '&' : '?'}page=${n}`)}">${label}</a>`;
  return `<nav class="pager" aria-label="Pages">
<span>${count(first)} to ${count(last)} of ${count(total)}</span>
${pageCount > 1 ? `<span class="pager-links">${pageNumber > 1 ? link(pageNumber - 1, 'Previous') : '<span class="off">Previous</span>'}<span>Page ${count(pageNumber)} of ${count(pageCount)}</span>${pageNumber < pageCount ? link(pageNumber + 1, 'Next') : '<span class="off">Next</span>'}</span>` : ''}
</nav>`;
}

const page = (options) => shell({ nav: sections('review', true), ...options });

const listUrl = (ruleId, status) => `/review/records?rule=${encodeURIComponent(ruleId)}&status=${encodeURIComponent(status)}`;

/** The Review overview: what is held and what is unmatched, per kind of record, each count a link to its list. */
export function reviewPage({ csrf, dryRun, catalog, counts, holds, asOf, notice = null, error = null }) {
  const of = (ruleId, status) => counts.find((c) => c.ruleId === ruleId && c.status === status)?.count ?? 0;
  const cell = (rule, status, label) => {
    const n = of(rule.id, status);
    return `<td class="num" data-label="${label}">${n ? `<a href="${esc(listUrl(rule.id, status))}">${count(n)}</a>` : '0'}</td>`;
  };
  const total = (statuses) => counts.filter((c) => statuses.includes(c.status) && catalog.rules.some((rule) => rule.id === c.ruleId)).reduce((sum, c) => sum + c.count, 0);
  const heldAssociations = total(['multiple_targets', 'associated_elsewhere']);
  const unmatched = total(['no_target']);
  const noId = total(['missing_key']);
  const failed = total(['failed']);

  const pairs = catalog.pairs.map((pair) => {
    const elsewhere = pair.rules.some((rule) => of(rule.id, 'associated_elsewhere') > 0);
    const rows = pair.rules.map((rule) => `<tr><td>${esc(rule.label)}<span class="sub">Matched on ${rule.keys.map((key) => `<code>${esc(key)}</code>`).join(' and ')}</span></td>${cell(rule, 'multiple_targets', 'Held for review')}${elsewhere ? cell(rule, 'associated_elsewhere', 'Linked elsewhere') : ''}${cell(rule, 'no_target', 'No match')}${cell(rule, 'missing_key', 'No ID')}${cell(rule, 'failed', 'Failed')}</tr>`).join('\n');
    return `<section class="review-pair" id="${esc(pair.id)}">
<h3>${esc(pair.from.label)} <span class="health-to">to</span> ${esc(pair.to.label)}</h3>
<div class="table-wrap"><table class="rules">
<thead><tr><th>How it is matched</th><th class="num">Held for review</th>${elsewhere ? '<th class="num">Linked elsewhere</th>' : ''}<th class="num">No match</th><th class="num">No ID</th><th class="num">Failed</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</section>`;
  }).join('\n');

  const stat = (label, value, note, tone = '') => `<div class="stat${tone}">
<p class="stat-label">${label}</p>
<p class="stat-value">${count(value)}</p>
<p class="stat-note">${note}</p>
</div>`;
  const waiting = holds.open - holds.released;
  const dealCard = catalog.dealAmount
    ? `<section class="card">
<h2>Deal amount changes held</h2>
<p class="muted">Changes to a deal amount that the service did not apply because they are unusually large or would set the deal to 0.</p>
<p class="lead">${holds.open
    ? `<strong>${plural(holds.open, 'change is', 'changes are')} held.</strong>${holds.released ? ` ${plural(holds.released, 'is', 'are')} released and will be applied by the next ${dryRun ? 'live ' : ''}run; ${count(waiting)} still ${waiting === 1 ? 'waits' : 'wait'} for a decision.` : ''}`
    : 'No deal amount change is held.'}</p>
<p class="actions"><a class="button" href="/review/deal-amounts">${holds.open ? 'Review and release' : 'Open the list'}</a></p>
</section>`
    : '';

  const body = `${notices(notice, error)}<div class="stats">
${stat('Held associations', heldAssociations, 'more than one match, not linked', heldAssociations ? ' warn' : '')}
${stat('Held deal amounts', holds.open, holds.released ? `${count(holds.released)} released, waiting for a run` : 'not applied to the deal', holds.open ? ' warn' : '')}
${stat('No match', unmatched, 'on the lists below')}
${stat('No ID', noId, failed ? `and ${count(failed)} failed` : 'on the lists below', failed ? ' bad' : '')}
</div>
${dealCard}
<section class="card">
<h2>Associations</h2>
<p class="muted">The records the service could not link, by the reason. ${asOf ? `As of the live run finished <span class="nowrap">${esc(when(asOf))}</span>.` : 'No live run has finished yet, so these lists are empty: a dry run does not fill them.'} Every live run brings the lists up to date, and a record leaves its list as soon as the reason is gone.</p>
${pairs}
<p class="hint">Choose a number to see the records, each with a link that opens it in HubSpot${catalog.portalId ? '' : ' (the links are off until the mapping has a <code>portalId</code>)'}. A record matched in more than one way can be on more than one list.</p>
</section>`;
  return page({ title: 'Review', heading: 'Review', sub: 'Records held for review and records without a match', csrf, dryRun, body });
}

/** One list: the records of one rule that are on the review list for one reason. */
export function recordsPage({ csrf, dryRun, catalog, rule, status, items, total, pageNumber, pageCount, pageSize }) {
  const reason = REASONS[status];
  const base = listUrl(rule.id, status);
  const linkDetail = status === 'multiple_targets' || status === 'associated_elsewhere';
  const keyHead = rule.keys.length === 1 ? `ID on the record (<code>${esc(rule.keys[0])}</code>)` : 'ID on the record';
  const rows = items.map((item) => {
    const key = keyValue(rule, item.key);
    return `<tr><td data-label="${esc(rule.from.label)}">${recordLink(catalog, rule.from, item.id)}</td><td data-label="ID on the record">${key === '' ? '<span class="muted">empty</span>' : `<code>${esc(key)}</code>`}</td><td data-label="Detail" class="detail">${linkDetail ? detailWithLinks(catalog, rule, item.detail) : esc(item.detail)}</td><td data-label="On the list since" class="nowrap">${esc(when(item.firstSeenAt))}</td></tr>`;
  }).join('\n');
  const body = `${crumbs([{ href: '/review', label: 'Review' }, { label: `${rule.from.label} to ${rule.to.label}` }, { label: rule.label }])}
<section class="card">
<div class="list-head">
<div>
<h2>${esc(reason.title)}</h2>
<p class="muted">${plural(total, `${rule.from.label} record`, `${rule.from.label} records`)}. ${esc(reason.explain(rule))}</p>
</div>
${total ? `<p class="actions"><a class="button secondary" href="${esc(`/review/records.csv?rule=${encodeURIComponent(rule.id)}&status=${encodeURIComponent(status)}`)}">Download CSV</a></p>` : ''}
</div>
${total ? `<div class="table-wrap"><table class="rules records">
<thead><tr><th>${esc(rule.from.label)}</th><th>${keyHead}</th><th>Detail</th><th>On the list since</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
${pager(base, pageNumber, pageCount, total, pageSize)}` : '<p class="lead">Nothing is on this list.</p>'}
<p class="hint">${catalog.portalId ? 'A record ID opens the record in HubSpot in a new tab.' : 'Record links are off until the mapping has a <code>portalId</code>.'} The list is as the last live run found it.</p>
</section>`;
  return page({ title: `${reason.title}: ${rule.label}`, heading: 'Review', sub: `${rule.from.label} to ${rule.to.label}`, csrf, dryRun, body });
}

const releaseEffect = (dryRun) => (dryRun
  ? 'The service is in dry-run mode, so a release is recorded now and applied by the first live run.'
  : 'The next run, scheduled or started with Sync now, then sets the deal amount in HubSpot.');

/** The deal amount changes the guard holds, with a way to release them. */
export function dealAmountsPage({ csrf, dryRun, catalog, holds, applied = [], counts, pageNumber, pageCount, pageSize, notice = null, error = null }) {
  const { header, deal } = catalog.dealAmount;
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const waiting = counts.open - counts.released;
  const rows = holds.map((hold) => {
    const state = hold.releasedAt
      ? `<span class="badge good">Released</span><span class="sub">${esc(when(hold.releasedAt))}, waiting for the next ${dryRun ? 'live ' : ''}run</span><form method="post" action="/review/deal-amounts/cancel">${hidden}<input type="hidden" name="hold" value="${esc(hold.id)}"><button type="submit" class="quiet">Cancel release</button></form>`
      : `<label class="check pick"><input type="checkbox" name="hold" value="${esc(hold.id)}" form="release"> Select</label>`;
    return `<tr><td data-label="${esc(deal.label)}">${recordLink(catalog, deal, hold.dealId)}</td><td data-label="${esc(header.label)}">${recordLink(catalog, header, hold.headerId)}${hold.quoteNumber ? `<span class="sub">Quote ${esc(hold.quoteNumber)}</span>` : ''}</td><td class="num" data-label="Deal amount now">${money(hold.from)}</td><td class="num" data-label="Quote amount, not applied">${money(hold.to)}</td><td class="num" data-label="Difference">${difference(hold.from, hold.to)}</td><td data-label="Why held" class="detail">${esc(holdReasons(catalog, hold.reasons))}</td><td data-label="Held since" class="nowrap">${esc(when(hold.firstHeldAt))}</td><td data-label="Release" class="act">${state}</td></tr>`;
  }).join('\n');
  const done = applied.map((hold) => `<tr><td data-label="${esc(deal.label)}">${recordLink(catalog, deal, hold.dealId)}</td><td data-label="${esc(header.label)}">${recordLink(catalog, header, hold.headerId)}${hold.quoteNumber ? `<span class="sub">Quote ${esc(hold.quoteNumber)}</span>` : ''}</td><td class="num" data-label="Deal amount before">${money(hold.from)}</td><td class="num" data-label="Set to">${money(hold.releasedAmount)}</td><td data-label="Released" class="nowrap">${esc(when(hold.releasedAt))}</td><td data-label="Applied by a run" class="nowrap">${esc(when(hold.appliedAt))}</td></tr>`).join('\n');
  const body = `${notices(notice, error)}${crumbs([{ href: '/review', label: 'Review' }, { label: 'Deal amount changes held' }])}
<section class="card">
<div class="list-head">
<div>
<h2>Deal amount changes held</h2>
<p class="muted">${counts.open
    ? `${plural(counts.open, 'change', 'changes')} not applied${counts.released ? `; ${count(counts.released)} released and waiting for a run, ${count(waiting)} waiting for a decision` : ''}. The deal still carries the amount under Deal amount now.`
    : 'No deal amount change is held.'}</p>
</div>
${counts.open ? '<p class="actions"><a class="button secondary" href="/review/deal-amounts.csv">Download CSV</a></p>' : ''}
</div>
${counts.open ? `<form id="release" method="get" action="/review/deal-amounts/release"></form>
<div class="table-wrap"><table class="rules records holds">
<thead><tr><th>${esc(deal.label)}</th><th>${esc(header.label)}</th><th class="num">Deal amount now</th><th class="num">Quote amount, not applied</th><th class="num">Difference</th><th>Why held</th><th>Held since</th><th>Release</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
${pager('/review/deal-amounts', pageNumber, pageCount, counts.open, pageSize)}
${waiting ? `<div class="release-bar">
<button type="submit" form="release">Release selected</button>
<button type="submit" form="release" name="all" value="1" class="secondary">Release all ${count(Math.min(waiting, pageSize))}${waiting > pageSize ? ' oldest' : ''}</button>
<p class="hint">Nothing is released yet at this step: the next page lists what you chose and asks you to confirm.</p>
</div>` : ''}` : ''}
<p class="hint">Releasing a change lets the service set that deal to the quote amount shown. ${releaseEffect(dryRun)} A release is for the amount shown: if the quote amount changes before the run, the change is held again and needs a new decision. Every run looks at each held change again, and a change leaves this list when it is applied or no longer applies.</p>
</section>${applied.length ? `
<section class="card">
<h2>Released and applied</h2>
<p class="muted">The latest changes released on this page that a run has applied to the deal.</p>
<div class="table-wrap"><table class="rules records applied">
<thead><tr><th>${esc(deal.label)}</th><th>${esc(header.label)}</th><th class="num">Deal amount before</th><th class="num">Set to</th><th>Released</th><th>Applied by a run</th></tr></thead>
<tbody>
${done}
</tbody>
</table></div>
</section>` : ''}`;
  return page({ title: 'Deal amount changes held', heading: 'Review', sub: 'Deal amount changes held', csrf, dryRun, body });
}

/** The step between choosing changes and releasing them: lists exactly what will be released. */
export function releaseConfirmPage({ csrf, dryRun, catalog, holds, notFound = 0 }) {
  const { header, deal } = catalog.dealAmount;
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const rows = holds.map((hold) => `<tr><td data-label="${esc(deal.label)}">${recordLink(catalog, deal, hold.dealId)}</td><td data-label="${esc(header.label)}">${recordLink(catalog, header, hold.headerId)}${hold.quoteNumber ? `<span class="sub">Quote ${esc(hold.quoteNumber)}</span>` : ''}</td><td class="num" data-label="Deal amount now">${money(hold.from)}</td><td class="num" data-label="Will be set to">${money(hold.to)}</td><td class="num" data-label="Difference">${difference(hold.from, hold.to)}</td><td data-label="Why held" class="detail">${esc(holdReasons(catalog, hold.reasons))}</td></tr>`).join('\n');
  const inputs = holds.map((hold) => `<input type="hidden" name="hold" value="${esc(`${hold.id}:${hold.to}`)}">`).join('');
  const body = `${crumbs([{ href: '/review', label: 'Review' }, { href: '/review/deal-amounts', label: 'Deal amount changes held' }, { label: 'Release' }])}
${notFound ? `<p class="notice info" role="status">${plural(notFound, 'chosen change is', 'chosen changes are')} left out: already released, applied, or no longer held.</p>\n` : ''}<section class="card">
<h2>Release ${plural(holds.length, 'deal amount change', 'deal amount changes')}</h2>
${holds.length ? `<p class="muted">Each deal below will be set to the amount under Will be set to. ${releaseEffect(dryRun)} A release can be cancelled on the list until a run has applied it.</p>
<div class="table-wrap"><table class="rules records">
<thead><tr><th>${esc(deal.label)}</th><th>${esc(header.label)}</th><th class="num">Deal amount now</th><th class="num">Will be set to</th><th class="num">Difference</th><th>Why held</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<form method="post" action="/review/deal-amounts/release" class="release-bar">
${hidden}${inputs}
<button type="submit">Release ${plural(holds.length, 'change', 'changes')}</button>
<a class="button secondary" href="/review/deal-amounts">Back, release nothing</a>
</form>` : `<p class="lead">Nothing was chosen. Tick Select on the changes to release, then choose Release selected.</p>
<p class="actions"><a class="button secondary" href="/review/deal-amounts">Back to the list</a></p>`}
</section>`;
  return page({ title: 'Release deal amount changes', heading: 'Review', sub: 'Release deal amount changes', csrf, dryRun, body });
}
