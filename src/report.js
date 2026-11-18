import fs from 'node:fs';
import path from 'node:path';
import { runStamp } from './util.js';

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

const MAX_REPORT_ROWS = 500;
const HOLD_REASONS = {
  sets_deal_to_zero: () => 'would set the deal amount to 0',
  change_over_threshold: (guard) => `moves the deal amount by more than ${guard?.largeChangeThreshold ?? 'the threshold'}`,
  change_over_percent: (guard) => `changes the deal amount by more than ${guard?.percentChangeThreshold ?? 'the set'}%`,
};

export function holdReasonText(reasons, guard) {
  return (reasons || []).map((reason) => (HOLD_REASONS[reason] ? HOLD_REASONS[reason](guard) : reason)).join('; ');
}

function amountChange(from, to) {
  const delta = Math.round((Number(to || 0) - Number(from || 0)) * 100) / 100;
  return Number.isFinite(delta) ? delta : '';
}

/** The change as a percentage of the deal's current amount; blank when that amount is 0 or blank. */
export function changePercent(from, to) {
  const before = Number(from || 0);
  if (!Number.isFinite(before) || before === 0) return '';
  const pct = (Math.abs(Number(to || 0) - before) / Math.abs(before)) * 100;
  return Number.isFinite(pct) ? Math.round(pct * 10) / 10 : '';
}

const shown = (value) => (value === '' || value === null || value === undefined ? '(blank)' : value);

/** Totals over a list of deal amount changes ({ from, to }). */
export function changeTotals(changes) {
  const totals = { count: changes.length, up: 0, upTotal: 0, down: 0, downTotal: 0, net: 0 };
  for (const c of changes) {
    const delta = Number(amountChange(c.from, c.to)) || 0;
    if (delta > 0) {
      totals.up += 1;
      totals.upTotal += delta;
    } else if (delta < 0) {
      totals.down += 1;
      totals.downTotal += delta;
    }
  }
  for (const key of ['upTotal', 'downTotal']) totals[key] = Math.round(totals[key] * 100) / 100;
  totals.net = Math.round((totals.upTotal + totals.downTotal) * 100) / 100;
  return totals;
}

function heldSection(d, dry) {
  const lines = ['### Deal amount changes held for review', ''];
  const guard = d.guard || {};
  const rules = [
    guard.holdZeroAmount ? 'it would set the deal amount to 0' : null,
    guard.holdLargeChange ? `it moves the deal amount by more than ${guard.largeChangeThreshold}, up or down` : null,
    guard.holdPercentChange ? `it changes the deal amount by more than ${guard.percentChangeThreshold}% of what the deal carries now (any change, when the deal carries 0 or nothing)` : null,
  ].filter(Boolean);
  lines.push(rules.length
    ? `A deal amount change is held, not applied, when ${rules.join(', or ')} (dealAmount.guard in the mapping).`
    : 'The guard on deal amount changes is switched off (dealAmount.guard in the mapping).');
  lines.push('');
  if (d.held.length === 0) {
    lines.push('No deal amount change is held.');
  } else {
    lines.push(`${d.held.length} deal amount change(s) ${dry ? 'would be' : 'are'} held. The deals were not changed. Each one is looked at again on every run and stays on this list until it is released in the mapping or no longer applies.`);
    lines.push('');
    lines.push(table(
      ['Deal ID', 'Quote header ID', 'Deal amount now', 'Quote amount (not applied)', 'Why held', 'Held since'],
      d.held.slice(0, MAX_REPORT_ROWS).map((c) => [c.dealId, c.headerId, shown(c.from), shown(c.to), holdReasonText(c.reasons, guard), c.heldSince || (dry ? 'not recorded (dry run)' : 'this run')]),
    ));
    if (d.held.length > MAX_REPORT_ROWS) {
      lines.push('');
      lines.push(`The first ${MAX_REPORT_ROWS} are shown; all of them are in the deal amounts CSV.`);
    }
  }
  lines.push('');
  const ended = [
    ...(d.holdsReleased || []).map((hold) => [hold, dry ? 'would be applied: the guard no longer holds it' : 'applied: the guard no longer holds it']),
    ...(d.holdsNoLongerApply || []).map((hold) => [hold, dry ? 'would be closed: it no longer applies' : 'closed: it no longer applies']),
  ];
  if (ended.length) {
    lines.push(`${ended.length} change(s) held on earlier runs ${dry ? 'would come' : 'came'} off the list in this run:`);
    lines.push('');
    lines.push(table(
      ['Deal ID', 'Quote header ID', 'Deal amount when held', 'Quote amount when held', 'Held since', 'Outcome'],
      ended.slice(0, MAX_REPORT_ROWS).map(([hold, outcome]) => [hold.dealId, hold.headerId, shown(hold.from), shown(hold.to), hold.firstHeldAt, outcome]),
    ));
    lines.push('');
  }
  return lines;
}

function projectionSection(d) {
  const p = d.projection;
  const guard = d.guard || {};
  const lines = ['### Projected deal amount changes once lines are linked', ''];
  lines.push(`A live run would link ${p.linesToLink} line(s) to ${p.headersGainingLines} quote header(s). HubSpot then recalculates those quote amounts, and the next run sets the deal amounts. The amounts below are worked out here as the sum of the amounts of each quote's lines (those it has now plus those that would be linked); nothing in HubSpot was changed to get them.`);
  lines.push('');
  if (p.linksTruncated) {
    lines.push('This run had a --limit, so only the lines within the limit are projected.');
    lines.push('');
  }
  const applied = p.changes.filter((c) => !c.held && !c.skippedClosed);
  const held = p.changes.filter((c) => c.held);
  const closed = p.changes.filter((c) => c.skippedClosed);
  const t = changeTotals(applied);
  lines.push(table(
    ['Quote headers gaining lines', 'Quote amount would change', 'Quote amount unchanged', 'Deals already equal to the new amount', 'Deals that would be updated', 'Deal changes the guard would hold', 'Closed deals left alone'],
    [[p.headersGainingLines, p.headersWithAmountChange, p.headersUnchanged, p.inSync, p.wouldUpdate, p.heldCount, p.closedSkippedCount || 0]],
  ));
  lines.push('');
  lines.push(`Deals that would be updated: ${t.up} up (+${t.upTotal}), ${t.down} down (${t.downTotal}), net ${t.net}. Held changes and closed deals are not in these totals.`);
  lines.push('');
  const skipped = Object.entries(p.skipped).filter(([reason, n]) => n > 0 && reason !== 'deal_closed');
  if (skipped.length) {
    lines.push('Quotes whose amount would change without a deal update:');
    for (const [reason, n] of skipped) lines.push(`- ${reason}: ${n}`);
    lines.push('');
  }
  if (p.changes.length) {
    const rows = [...held, ...applied, ...closed].slice(0, MAX_REPORT_ROWS);
    const result = (c) => {
      if (c.held) return `HELD: ${holdReasonText(c.reasons, guard)}`;
      return c.skippedClosed ? 'not changed: the deal is closed' : 'would be updated';
    };
    lines.push(table(
      ['Deal ID', 'Quote header ID', 'Deal', 'Deal amount before', 'Deal amount after', 'Change', 'Change %', 'Result'],
      rows.map((c) => [c.dealId, c.headerId, c.dealClosed === undefined ? '' : c.dealClosed ? 'closed' : 'open', shown(c.from), shown(c.to), amountChange(c.from, c.to), changePercent(c.from, c.to), result(c)]),
    ));
    lines.push('');
    if (p.changes.length > MAX_REPORT_ROWS) {
      lines.push(`The first ${MAX_REPORT_ROWS} are shown; all ${p.changes.length} are in the projected deal amounts CSV.`);
      lines.push('');
    }
  }
  return lines;
}

/** Before and after counts for one rule. In dry run "after" is the projection. */
export function ruleCounts(rule, dryRun) {
  const createdSources = dryRun ? rule.planned : rule.created + rule.createdUnverified;
  return {
    checked: rule.sources,
    before: rule.alreadyAssociated,
    filled: createdSources,
    after: rule.alreadyAssociated + createdSources,
    noTarget: rule.noTarget,
    noMatchButAssociated: rule.noMatchButAssociated || 0,
    multipleTargets: rule.multipleTargets,
    missingKey: rule.missingKey,
    multipleTargetKeys: rule.multipleTargetKeys || 0,
    associatedElsewhere: rule.associatedElsewhere || 0,
    addedAlongsideOther: rule.addedAlongsideOther || 0,
    notAttempted: rule.notAttempted || 0,
    failed: rule.failed,
  };
}

/** The run summary without the per-record lists, as stored in the staging database. */
export function compactSummary(summary) {
  return {
    ...summary,
    rules: (summary.rules || []).map(({ unresolved, links, ...counts }) => counts),
    dealAmount: summary.dealAmount
      ? (({ changes, failures, held, closedSkipped, holdsReleased, holdsNoLongerApply, projection, ...counts }) => ({
        ...counts,
        closedSkipped: (closedSkipped || []).slice(0, 200),
        failures: (failures || []).slice(0, 20),
        held: (held || []).slice(0, 200),
        holdsReleased: (holdsReleased || []).slice(0, 200),
        holdsNoLongerApply: (holdsNoLongerApply || []).slice(0, 200),
        projection: projection ? (({ changes: rows, ...totals }) => totals)(projection) : null,
      }))(summary.dealAmount)
      : null,
  };
}

export function renderRunMarkdown(summary) {
  const dry = summary.dryRun;
  const lines = [];
  const title = summary.mode === 'full' ? 'Reconciliation report' : 'Run report';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- Run ID: ${summary.runId}`);
  lines.push(`- Mode: ${summary.mode}${summary.limit ? ` (limited to ${summary.limit} changed records per association and ${summary.limit} deal updates)` : ''}`);
  lines.push(`- ${dry ? 'DRY RUN: nothing was changed in HubSpot. "After" and "filled" are what a live run would do.' : 'LIVE RUN: changes were written to HubSpot.'}`);
  lines.push(`- Started: ${summary.startedAt}`);
  lines.push(`- Finished: ${summary.finishedAt}`);
  lines.push(`- Status: ${summary.status}${summary.error ? ` (${summary.error})` : ''}`);
  lines.push('');
  const ingest = Object.entries(summary.ingest || {});
  if (ingest.length) {
    lines.push('## Staging database');
    lines.push('');
    lines.push('Records copied from HubSpot into the staging database at the start of this run. Matching is done on the staging copy.');
    lines.push('');
    lines.push(table(
      ['Object', 'Read from HubSpot', 'Scope', 'No longer in HubSpot'],
      ingest.map(([key, i]) => [key, i.records, i.mode === 'full' ? 'every record' : `created or modified since ${i.since}`, i.markedMissing]),
    ));
    lines.push('');
  }
  lines.push('## Association counts before and after');
  lines.push('');
  lines.push('Counts are source records (for example quote lines for "Lines to header").');
  lines.push('');
  lines.push(table(
    ['Item', 'Association', 'Records checked', 'Associated before', dry ? 'Would be filled' : 'Filled', dry ? 'Associated after (projected)' : 'Associated after', 'No match found', 'More than one match', 'Blank Epicor ID', 'Left on another record', 'Failed'],
    summary.rules.map((rule) => {
      const c = ruleCounts(rule, dry);
      return [rule.item, rule.label, c.checked, c.before, c.filled, c.after, c.noTarget, c.multipleTargets, c.missingKey, c.associatedElsewhere, c.failed];
    }),
  ));
  lines.push('');
  const alongside = summary.rules.filter((r) => r.addedAlongsideOther > 0);
  for (const rule of alongside) {
    lines.push(`${rule.label}: ${rule.addedAlongsideOther} of the filled record(s) already had a different record of that type associated; the matching one ${dry ? 'would be' : 'was'} added next to it.`);
  }
  if (alongside.length) lines.push('');
  const covered = summary.rules.filter((r) => r.noMatchButAssociated > 0);
  for (const rule of covered) {
    lines.push(`${rule.label}: ${rule.noMatchButAssociated} more record(s) have no match this way but already have a record of that type associated. They are not counted under "No match found".`);
  }
  if (covered.length) lines.push('');
  const limited = summary.rules.filter((r) => r.notAttempted > 0);
  for (const rule of limited) {
    lines.push(`${rule.label}: ${rule.notAttempted} more record(s) need this association and were left for a run without --limit.`);
  }
  if (limited.length) lines.push('');
  const gone = summary.rules.reduce((n, r) => n + (r.gone || 0), 0);
  if (gone > 0) {
    lines.push(`${gone} record(s) no longer exist in HubSpot and were dropped from the staging database.`);
    lines.push('');
  }

  lines.push('## Held for review');
  lines.push('');
  lines.push('Records the middleware did not associate because the match is not clear-cut. Nothing was changed for them. The record IDs are in the unresolved CSV and, after a live run, in the review_items table.');
  lines.push('');
  lines.push(table(
    ['Item', 'Association', 'Key matches more than one record: records held', 'Distinct key values involved', 'Already on a different record: records held'],
    summary.rules.map((rule) => [rule.item, rule.label, rule.multipleTargets, rule.multipleTargetKeys || 0, rule.associatedElsewhere || 0]),
  ));
  lines.push('');
  const heldWithParent = summary.rules.filter((r) => r.multipleTargetsAlreadyAssociated > 0);
  for (const rule of heldWithParent) {
    lines.push(`${rule.label}: ${rule.multipleTargetsAlreadyAssociated} of the ${rule.multipleTargets} record(s) whose key matches more than one record already have a record of that type associated.`);
  }
  if (heldWithParent.length) lines.push('');

  const unverified = summary.rules.reduce((n, r) => n + r.createdUnverified, 0);
  if (unverified > 0) {
    lines.push(`${unverified} filled record(s) could not be confirmed on re-read and will be checked again on the next run.`);
    lines.push('');
  }
  if (summary.dealAmount) {
    const d = summary.dealAmount;
    lines.push('## Deal amounts (Item B3)');
    lines.push('');
    lines.push(table(
      ['Quote headers checked', 'Seen for the first time (amount recorded)', 'Amount recorded without updating the deal (lines linked from the backlog)', d.backfill ? 'Compared with their deal (catch-up)' : 'Headers with an amount change', 'Deals already in sync', dry ? 'Deals that would be updated' : 'Deals updated', 'Held for review', 'Failed'],
      [[d.headersChecked, d.headersFirstSeen, d.headersRecordedOnly || 0, d.backfill ? d.headersChecked : d.headersWithAmountChange, d.inSync, dry ? d.planned : d.updated, d.held.length, d.failed]],
    ));
    lines.push('');
    if (dry) {
      lines.push('In a dry run the recorded header amounts are not changed, so the same headers show up again until a live run records them.');
      lines.push('');
    }
    if (d.headersWithLinesLinked > 0) {
      const after = d.backlog
        ? 'the new amount is recorded without changing the deal (backlogLinkedLines is "record_only")'
        : 'the next run that sees the new amount sets the deal to it';
      lines.push(dry
        ? `${d.headersWithLinesLinked} quote header(s) would have lines linked by a live run. HubSpot recalculates a header's amount after its lines are linked, and ${after}. Those amounts are not known before the lines are linked, so they are not in the table above${d.projection ? '; the projection further down works them out from the line amounts' : ''}.`
        : `${d.headersWithLinesLinked} quote header(s) had lines linked in this run. HubSpot recalculates a header's amount after its lines are linked, and ${after}.`);
      lines.push('');
    }
    if (d.requireNewLines && !d.backfill) {
      lines.push(`A deal amount only follows its quote when the quote gained a new line: a line this run linked, or a line that arrived since the previous run (dealAmount.requireNewLines). ${d.headersChangedWithoutNewLines || 0} quote header(s) changed amount without gaining a line; the new amount was recorded and the deal left alone.`);
      lines.push('');
      lines.push(d.arrivalsSince
        ? `Lines first read after ${d.arrivalsSince}, the start of the last live run, count as arrived: ${d.headersWithArrivedLines || 0} quote header(s) have such a line.`
        : 'No earlier live run is recorded in this staging database, so no line counts as arrived since the previous run; only lines linked by a run count until the first live run has finished.');
      lines.push('');
    }
    if (d.skipClosedDeals) {
      lines.push(`Closed deals are never changed (dealAmount.skipClosedDeals). ${d.skipped.deal_closed} deal amount change(s) were left alone for that reason${(d.closedSkipped || []).length ? '; they are in the deal amounts CSV' : ''}.`);
      lines.push('');
    }
    if (d.notAttempted > 0) {
      lines.push(`${d.notAttempted} more deal(s) need an amount update and were left for a run without --limit.`);
      lines.push('');
    }
    const skipped = Object.entries(d.skipped).filter(([, n]) => n > 0);
    if (skipped.length) {
      lines.push('Skipped:');
      for (const [reason, n] of skipped) lines.push(`- ${reason}: ${n}`);
      lines.push('');
    }
    lines.push(...heldSection(d, dry));
    if (d.projection) lines.push(...projectionSection(d));
  }
  return lines.join('\n');
}

/**
 * Writes the report for a run: Markdown summary, full JSON, a CSV of records
 * that could not be associated, a CSV of every association created (or
 * planned), and a CSV of deal amount changes.
 */
export function writeRunReport(dir, summary) {
  fs.mkdirSync(dir, { recursive: true });
  const prefix = summary.mode === 'full' ? 'reconciliation' : 'run';
  const base = path.join(dir, `${prefix}-${runStamp(new Date(summary.startedAt))}${summary.dryRun ? '-dryrun' : ''}`);
  const files = { markdown: `${base}.md`, json: `${base}.json`, unresolved: `${base}-unresolved.csv`, associations: `${base}-associations.csv` };

  fs.writeFileSync(files.markdown, renderRunMarkdown(summary) + '\n');
  fs.writeFileSync(files.json, JSON.stringify(summary, null, 2));

  const rows = ['rule,record_id,status,epicor_key,detail'];
  for (const rule of summary.rules) {
    for (const u of rule.unresolved) {
      rows.push([rule.id, u.id, u.status, u.key, u.detail].map(csvCell).join(','));
    }
  }
  fs.writeFileSync(files.unresolved, rows.join('\n') + '\n');

  const linkRows = ['rule,from_record_id,to_record_id,result'];
  for (const rule of summary.rules) {
    for (const link of rule.links || []) linkRows.push([rule.id, link.fromId, link.toId, link.planned ? 'planned' : 'created'].map(csvCell).join(','));
  }
  fs.writeFileSync(files.associations, linkRows.join('\n') + '\n');

  if (summary.dealAmount) {
    files.dealChanges = `${base}-deal-amounts.csv`;
    const dealRows = ['deal_id,quote_header_id,amount_before,amount_after,result,held_since'];
    const result = summary.dryRun ? 'planned' : 'updated';
    for (const c of summary.dealAmount.changes) dealRows.push([c.dealId, c.headerId, c.from, c.to, result, ''].map(csvCell).join(','));
    for (const c of summary.dealAmount.closedSkipped || []) dealRows.push([c.dealId, c.headerId, c.from, c.to, 'skipped: deal is closed', ''].map(csvCell).join(','));
    for (const c of summary.dealAmount.held) dealRows.push([c.dealId, c.headerId, c.from, c.to, `held: ${c.reasons.join('; ')}`, c.heldSince || ''].map(csvCell).join(','));
    for (const c of summary.dealAmount.failures) dealRows.push([c.dealId, c.headerId, c.from, c.to, `failed: ${c.error}`, ''].map(csvCell).join(','));
    fs.writeFileSync(files.dealChanges, dealRows.join('\n') + '\n');
    if (summary.dealAmount.projection) {
      files.projectedDealChanges = `${base}-projected-deal-amounts.csv`;
      const rows = ['deal_id,quote_header_id,deal_state,quote_amount_now,deal_amount_before,deal_amount_after,change,change_percent,result'];
      for (const c of summary.dealAmount.projection.changes) {
        const state = c.dealClosed === undefined ? '' : c.dealClosed ? 'closed' : 'open';
        const result = c.held ? `held: ${c.reasons.join('; ')}` : c.skippedClosed ? 'skipped: deal is closed' : 'would_update';
        rows.push([c.dealId, c.headerId, state, c.headerAmountNow, c.from, c.to, amountChange(c.from, c.to), changePercent(c.from, c.to), result].map(csvCell).join(','));
      }
      fs.writeFileSync(files.projectedDealChanges, rows.join('\n') + '\n');
    }
  }
  return files;
}

/** Short plain-text summary used in logs and alerts. */
export function summaryLines(summary) {
  const lines = [
    `Run ${summary.runId} (${summary.mode}${summary.dryRun ? ', dry run' : ''}) finished with status: ${summary.status}`,
  ];
  if (summary.error) lines.push(`Error: ${summary.error}`);
  for (const rule of summary.rules || []) {
    const c = ruleCounts(rule, summary.dryRun);
    const held = c.multipleTargets + c.associatedElsewhere;
    lines.push(`${rule.label}: checked ${c.checked}, ${summary.dryRun ? 'would fill' : 'filled'} ${c.filled}, no match ${c.noTarget}, held for review ${held}, failed ${c.failed}`);
  }
  if (summary.dealAmount) {
    const d = summary.dealAmount;
    lines.push(`Deal amounts: ${summary.dryRun ? d.planned : d.updated} ${summary.dryRun ? 'would be updated' : 'updated'}, held for review ${d.heldCount ?? d.held.length}, failed ${d.failed}${d.skipClosedDeals ? `, closed deals left alone ${d.skipped.deal_closed}` : ''}${d.requireNewLines ? `, quote amount changes without a new line ${d.headersChangedWithoutNewLines || 0}` : ''}`);
    if (d.projection) lines.push(`Projected once lines are linked: ${d.projection.wouldUpdate} deal amount(s) would be updated, ${d.projection.heldCount} held for review, ${d.projection.closedSkippedCount || 0} closed deal(s) left alone`);
  }
  return lines;
}
