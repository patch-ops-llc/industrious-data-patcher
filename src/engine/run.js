import crypto from 'node:crypto';
import { enabledRules, isPlaceholder, propertiesFor } from '../config.js';
import {
  acquireRunLock,
  closeAbandonedRuns,
  countRecords,
  finishRun,
  flagHeaders,
  hasCompletedLiveRun,
  headerAmountCandidates,
  headersToRecheck,
  getArrivalsSince,
  insertRun,
  markNewLines,
  openDealAmountHolds,
  recordsArrivedSince,
  saveArrivalsSince,
  pruneRuns,
  releaseRunLock,
  saveBaselines,
  saveDealAmountHolds,
  touchRunLock,
  upsertRecords,
} from '../db/store.js';
import { compactSummary, renderRunMarkdown } from '../report.js';
import { newRuleStats, processRule } from './associate.js';
import { newDealAmountStats, projectLinkedLineAmounts, syncDealAmounts } from './dealAmount.js';
import { linkHealth } from './health.js';
import { ingestAll, objectsToIngest } from './ingest.js';

const MAX_LINK_ROWS = 200_000;
const MS_PER_DAY = 86_400_000;
const ABANDONED_DRY_RUN_MS = 6 * 3_600_000;
const LOCK_HEARTBEAT_MS = 60_000;

/** Keeps the run lock fresh while the run is going, so a lock only goes stale when its process has died. */
export function startLockHeartbeat(db, holder, now) {
  const timer = setInterval(() => {
    touchRunLock(db, holder, now()).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

function isDealLinkRule(mapping, rule) {
  return rule.from === mapping.dealAmount.header && rule.to === mapping.dealAmount.deal;
}

/** The dry-run projection needs the line amount, which the mapping may not name. */
function canProject(mapping) {
  const cfg = mapping.dealAmount;
  if (!cfg.projection.enabled || !cfg.amountDependsOnRule) return false;
  const rule = mapping.rules.find((r) => r.id === cfg.amountDependsOnRule);
  const name = mapping.objects[rule?.from]?.properties?.[cfg.projection.lineAmount];
  return Boolean(name) && !isPlaceholder(name);
}

function backlogSettleUntil(cfg, startedAt) {
  return new Date(startedAt.getTime() + (cfg.backlogSettleMinutes || 0) * 60_000).toISOString();
}

/** How long after a header gained a line an amount change still counts as caused by it. */
function newLinesUntil(cfg, startedAt) {
  return new Date(startedAt.getTime() + (cfg.newLinesWindowMinutes || 0) * 60_000).toISOString();
}

function summarizeStatus(summary) {
  const ruleFailures = summary.rules.reduce((n, r) => n + r.failed, 0);
  const dealFailures = summary.dealAmount ? summary.dealAmount.failed : 0;
  return ruleFailures + dealFailures > 0 ? 'completed_with_errors' : 'ok';
}

/**
 * Item B3 for one run. Headers are compared with the amount recorded for them
 * in the staging database, so a change is found no matter which run (dry or
 * live) first copied it into staging.
 */
async function runDealAmounts(ctx, run, { touchedHeaderIds, headersWithNewLinks, gainedLines, plannedDealLinks, backfill, backlog }, stats) {
  const { api, db, mapping } = ctx;
  const cfg = mapping.dealAmount;
  const headerObj = mapping.objects[cfg.header];
  const amountProperty = headerObj.properties.amount;

  // Changes the guard held on earlier runs are looked at again on every run,
  // whether or not the header amount moved since, so a held change is either
  // still held, applied (guard released) or closed as no longer applying.
  const openHolds = await openDealAmountHolds(db);
  const forced = new Set(openHolds.map((hold) => hold.headerId));

  // The header amount can be a rollup that HubSpot recalculates after lines
  // change, so headers whose lines changed, and headers flagged by the
  // previous run, are read again instead of trusting the staging copy.
  const reread = [...new Set([...(await headersToRecheck(db, run.startedAt)), ...touchedHeaderIds, ...forced])];
  if (reread.length) {
    const records = await api.batchRead(headerObj.objectType, reread, propertiesFor(mapping, cfg.header));
    await upsertRecords(db, { objectKey: cfg.header, objectType: headerObj.objectType, records, runId: run.runId, now: run.startedAt });
  }

  const candidates = await headerAmountCandidates(db, {
    objectKey: cfg.header,
    amountProperty,
    includeIds: [...headersWithNewLinks, ...gainedLines, ...forced],
    all: backfill || cfg.trigger === 'any_difference',
  });
  const baseline = {};
  const recordOnly = new Set(backlog ? headersWithNewLinks : []);
  // Headers that gained a line in this run, or in an earlier run recently
  // enough that HubSpot may only now have recalculated their amount.
  const newLines = new Set(gainedLines);
  const stillMarked = (row) => Boolean(row.new_lines_until) && new Date(row.new_lines_until) > run.startedAt;
  for (const row of candidates) {
    if (row.known) baseline[row.id] = row.baseline;
    if (row.recheck === 'record_only') recordOnly.add(row.id);
    if (stillMarked(row)) newLines.add(row.id);
  }

  const outcome = await syncDealAmounts(
    ctx,
    candidates.map((row) => ({ id: row.id, properties: row.properties })),
    { baseline, recordOnly, newLines, forced, backfill, plannedLinks: plannedDealLinks, limit: run.limit },
    stats,
  );
  stats.headersChecked = await countRecords(db, cfg.header);
  stats.headersCompared = candidates.length;

  const pairKey = (change) => `${change.headerId}:${change.dealId}`;
  const heldBefore = new Map(openHolds.map((hold) => [pairKey(hold), hold]));
  const heldNow = new Set(stats.held.map(pairKey));
  for (const change of stats.held) change.heldSince = heldBefore.get(pairKey(change))?.firstHeldAt ?? null;
  // An update that failed or was held back by the limit is tried again next
  // run; its hold stays open until the deal is really updated.
  const pending = new Set(outcome.recheck);
  const resolved = [];
  for (const hold of openHolds) {
    if (heldNow.has(pairKey(hold))) continue;
    if (outcome.applied.has(hold.dealId)) {
      resolved.push({ id: hold.id, resolution: 'applied' });
      stats.holdsReleased.push(hold);
    } else if (!pending.has(hold.headerId)) {
      resolved.push({ id: hold.id, resolution: 'no_longer_applies' });
      stats.holdsNoLongerApply.push(hold);
    }
  }

  if (run.persist) {
    await saveDealAmountHolds(db, { held: stats.held, resolved, runId: run.runId, now: run.startedAt });
    const again = new Set(outcome.recheck);
    const settleUntil = backlogSettleUntil(cfg, run.startedAt);
    const markUntil = newLinesUntil(cfg, run.startedAt);
    // The mark "gained a new line". A header that gained a line in this run
    // keeps it for the whole window, because HubSpot may not have
    // recalculated its amount yet. A mark from an earlier run ends once the
    // amount change it explains has been looked at, or when its time runs
    // out. It is renewed for an update that has to be retried.
    const markFor = (row) => {
      if (again.has(row.id) || gainedLines.has(row.id)) return markUntil;
      if (outcome.evaluated.has(row.id)) return null;
      return stillMarked(row) ? new Date(row.new_lines_until).toISOString() : null;
    };
    const entries = candidates.map((row) => {
      let recheck = null;
      let until = null;
      // The header amount is a rollup that HubSpot recalculates some time after
      // lines are linked. A header whose backlog lines were just linked stays
      // "record only" until the settle time has passed, so the recalculated
      // amount is recorded without reaching the deal whichever run sees it.
      const held = row.recheck === 'record_only' && row.recheck_until && new Date(row.recheck_until) > run.startedAt;
      if (again.has(row.id)) {
        recheck = 'check';
      } else if (backlog && headersWithNewLinks.has(row.id)) {
        recheck = 'record_only';
        until = settleUntil;
      } else if (held) {
        recheck = 'record_only';
        until = new Date(row.recheck_until).toISOString();
      } else if (headersWithNewLinks.has(row.id)) {
        recheck = 'check';
      }
      return { id: row.id, amount: outcome.baseline[row.id] ?? '', recheck, until, newLinesUntil: markFor(row) };
    });
    await saveBaselines(db, { entries, now: run.startedAt });
  }
}

/**
 * One middleware run.
 *
 * 1. Ingest: copy the records of every object the enabled rules use from
 *    HubSpot into the staging database (everything the first time and once
 *    every FULL_REFRESH_HOURS, otherwise what was created or modified since
 *    the previous ingest).
 * 2. Association rules, in the order listed in the mapping file (lines to
 *    header, tasks to header, header to deal, header to company, IC codes to
 *    company, contacts to header). Matching happens in the staging database.
 * 3. Deal amounts (Item B3).
 *
 * mode "incremental" is the scheduled run. mode "full" (the reconcile
 * command) forces a full ingest and re-reads every association from HubSpot.
 * Both look at every record in staging, so a record that could not be
 * associated earlier is picked up as soon as its counterpart arrives.
 *
 * limit: create at most this many records' associations per rule, and update
 * at most this many deals.
 *
 * dealAmounts: true makes the run set every deal amount that differs from its
 * header amount (a one-off catch-up). Without it, deals are only updated when
 * a header amount has changed since the middleware last recorded it.
 *
 * A dry run sends nothing to HubSpot. It still refreshes the staging copy and
 * stores the run and what it would have done; it does not touch the review
 * list or the recorded header amounts.
 */
export async function executeRun(ctx, { mode = 'incremental', limit = null, dealAmounts } = {}) {
  const { api, db, mapping, settings, logger } = ctx;
  const now = ctx.now || (() => new Date());
  const startedAt = now();
  const summary = {
    runId: crypto.randomUUID(),
    mode,
    dryRun: api.dryRun,
    limit,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    status: 'failed',
    ingest: {},
    rules: [],
    health: null,
    dealAmount: null,
    api: null,
    stateSaved: false,
    error: null,
  };
  const log = logger.child({ runId: summary.runId, mode, dryRun: api.dryRun });
  log.info('run started', { limit });

  const run = {
    runId: summary.runId,
    startedAt,
    limit,
    persist: !api.dryRun,
    planned: new Map(),
    refreshed: new Map(),
    outcomes: new Map(),
    changed: {},
    arrived: {},
  };
  let locked = false;
  let heartbeat = null;
  let recorded = false;

  try {
    // Two live runs must not write associations at the same time (for example
    // a manual reconcile while the scheduled service is running).
    if (!api.dryRun) {
      locked = await acquireRunLock(db, { holder: summary.runId, now: startedAt, staleAfterMs: settings.runLockStaleMinutes * 60_000 });
      if (!locked) {
        summary.status = 'skipped';
        summary.error = 'another live run holds the run lock';
        summary.finishedAt = now().toISOString();
        log.warn('run skipped: another live run is in progress');
        return summary;
      }
    }
    if (locked) heartbeat = startLockHeartbeat(db, summary.runId, now);
    await closeAbandonedRuns(db, { holdsLock: locked, dryRunsBefore: new Date(startedAt.getTime() - ABANDONED_DRY_RUN_MS), now: startedAt });
    await insertRun(db, summary);
    recorded = true;

    const dealCfg = mapping.dealAmount;
    const backlog = dealCfg.enabled && dealCfg.backlogLinkedLines === 'record_only'
      && (mode === 'full' || !(await hasCompletedLiveRun(db)));

    const ingested = await ingestAll(ctx, objectsToIngest(mapping), { full: mode === 'full', runId: summary.runId, startedAt });
    for (const [key, result] of Object.entries(ingested)) {
      const { changed, objectKey, ...counts } = result;
      summary.ingest[key] = counts;
      run.changed[key] = changed;
    }

    // Lines that arrived since the last recording run that reached the deal
    // amounts. On a new database nothing counts as arrived.
    const lineRule = dealCfg.enabled && dealCfg.requireNewLines
      ? mapping.rules.find((r) => r.id === dealCfg.amountDependsOnRule && r.enabled)
      : null;
    let arrivalsSince = null;
    if (lineRule) {
      arrivalsSince = await getArrivalsSince(db, lineRule.from);
      run.arrived[lineRule.from] = arrivalsSince ? await recordsArrivedSince(db, { objectKey: lineRule.from, since: arrivalsSince }) : new Set();
    }

    const plannedDealLinks = [];
    const touchedHeaderIds = new Set();
    const headersWithNewLinks = new Set();
    const headersGainingLines = new Set();
    const headersWithArrivedLines = new Set();
    let lineLinks = [];
    let lineLinksTruncated = false;

    for (const rule of enabledRules(mapping)) {
      const stats = newRuleStats(rule);
      summary.rules.push(stats);
      run.refresh = mode === 'full' || ingested[rule.from]?.mode === 'full' || ingested[rule.to]?.mode === 'full';
      const outcome = await processRule(ctx, rule, run, stats);
      stats.links = outcome.links.slice(0, MAX_LINK_ROWS);
      stats.linksTruncated = outcome.links.length > MAX_LINK_ROWS;
      if (isDealLinkRule(mapping, rule)) {
        plannedDealLinks.push(...outcome.links.filter((link) => link.planned));
      }
      if (dealCfg.enabled && dealCfg.amountDependsOnRule === rule.id) {
        for (const id of outcome.touchedTargets) touchedHeaderIds.add(id);
        for (const id of outcome.newLinkTargets) headersWithNewLinks.add(id);
        for (const link of outcome.links) headersGainingLines.add(link.toId);
        for (const id of outcome.arrivedTargets) headersWithArrivedLines.add(id);
        lineLinks = outcome.links.filter((link) => link.planned);
        lineLinksTruncated = Boolean(limit) && stats.notAttempted > 0;
        if (run.persist && outcome.newLinkTargets.size) {
          await flagHeaders(db, {
            objectKey: dealCfg.header,
            amountProperty: mapping.objects[dealCfg.header].properties.amount,
            ids: outcome.newLinkTargets,
            recheck: backlog ? 'record_only' : 'check',
            until: backlog ? backlogSettleUntil(dealCfg, startedAt) : null,
            now: startedAt,
          });
        }
        const gained = new Set([...outcome.newLinkTargets, ...outcome.arrivedTargets]);
        if (run.persist && gained.size) {
          await markNewLines(db, { ids: gained, until: newLinesUntil(dealCfg, startedAt) });
        }
      }
      const { unresolved, links, ...counts } = stats;
      log.info('rule processed', counts);
    }
    summary.health = linkHealth(mapping, enabledRules(mapping), run.outcomes);
    for (const { rules, keys, ...counts } of summary.health) log.info('link health', counts);

    if (dealCfg.enabled) {
      const stats = newDealAmountStats();
      summary.dealAmount = stats;
      stats.backfill = Boolean(dealAmounts ?? (mode === 'full' && dealCfg.backfillInFullRun));
      stats.backlog = backlog;
      stats.headersWithLinesLinked = headersGainingLines.size;
      stats.headersWithArrivedLines = headersWithArrivedLines.size;
      stats.requireNewLines = dealCfg.requireNewLines;
      stats.arrivalsSince = arrivalsSince ? new Date(arrivalsSince).toISOString() : null;
      stats.skipClosedDeals = dealCfg.skipClosedDeals;
      const gainedLines = new Set([...headersGainingLines, ...headersWithArrivedLines]);
      stats.guard = { ...dealCfg.guard, releaseDealIds: dealCfg.guard.releaseDealIds.map(String) };
      delete stats.guard.notes;
      await runDealAmounts(ctx, run, { touchedHeaderIds, headersWithNewLinks, gainedLines, plannedDealLinks, backfill: stats.backfill, backlog }, stats);
      if (run.persist && lineRule) await saveArrivalsSince(db, lineRule.from, startedAt);
      if (api.dryRun && lineLinks.length && canProject(mapping)) {
        stats.projection = await projectLinkedLineAmounts(ctx, { lineLinks, plannedDealLinks });
        stats.projection.linksTruncated = lineLinksTruncated;
      }
      const { changes, failures, held, closedSkipped, holdsReleased, holdsNoLongerApply, projection, ...counts } = stats;
      counts.projected = projection ? { wouldUpdate: projection.wouldUpdate, held: projection.heldCount } : null;
      log.info('deal amounts processed', counts);
    }

    summary.status = summarizeStatus(summary);
    summary.stateSaved = run.persist;
  } catch (err) {
    summary.status = 'failed';
    summary.error = err?.message || String(err);
    log.error('run failed', { error: summary.error });
  }

  summary.finishedAt = now().toISOString();
  summary.api = { ...api.client.stats };
  try {
    if (recorded) {
      await finishRun(db, summary, { compact: compactSummary(summary), reportMarkdown: renderRunMarkdown(summary) });
      if (settings.keepRunsDays > 0) await pruneRuns(db, new Date(startedAt.getTime() - settings.keepRunsDays * MS_PER_DAY));
    }
  } catch (err) {
    log.error('could not store the run result in the staging database', { error: err?.message || String(err) });
    if (summary.status !== 'failed') {
      summary.status = 'failed';
      summary.error = `could not store the run result: ${err?.message || err}`;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) await releaseRunLock(db, summary.runId).catch(() => {});
  }
  log.info('run finished', { status: summary.status, api: summary.api, stateSaved: summary.stateSaved });
  return summary;
}
