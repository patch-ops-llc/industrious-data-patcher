import { isBlank, toNumber } from '../util.js';

const MAX_CHANGE_ROWS = 50_000;

export const HOLD_ZERO = 'sets_deal_to_zero';
export const HOLD_LARGE = 'change_over_threshold';
export const HOLD_PERCENT = 'change_over_percent';

export function newDealAmountStats() {
  return {
    item: 'B3',
    headersChecked: 0,
    headersFirstSeen: 0,
    headersRecordedOnly: 0,
    headersWithLinesLinked: 0,
    headersWithAmountChange: 0,
    inSync: 0,
    updated: 0,
    planned: 0,
    heldCount: 0,
    failed: 0,
    notAttempted: 0,
    skipped: {
      no_deal: 0,
      header_has_multiple_deals: 0,
      deal_has_multiple_headers: 0,
      header_amount_blank: 0,
      deal_closed: 0,
      deal_not_found: 0,
    },
    headersChangedWithoutNewLines: 0,
    changes: [],
    closedSkipped: [],
    held: [],
    holdsReleased: [],
    holdsNoLongerApply: [],
    projection: null,
    failures: [],
  };
}

function sameAmount(a, b) {
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === null && y === null) return true;
  if (x === null || y === null) return false;
  return Math.abs(x - y) < 0.005;
}

function amountText(value) {
  return isBlank(value) ? '' : String(value).trim();
}

/**
 * The guard on deal amount changes (dealAmount.guard in the mapping). Returns
 * the reasons a change from one amount to another is held for review instead
 * of being applied; an empty list means the change goes ahead. A blank deal
 * amount counts as 0 when measuring the size of the change. The percentage is
 * taken of the deal's current amount; with a current amount of 0 or blank no
 * percentage exists, and any change counts as over the percentage.
 */
export function guardReasons(cfg, { dealId, from, to }) {
  const guard = cfg.guard || {};
  if ((guard.releaseDealIds || []).some((id) => String(id) === String(dealId))) return [];
  const before = toNumber(from) ?? 0;
  const after = toNumber(to);
  const reasons = [];
  if (after === null) return reasons;
  if (guard.holdZeroAmount && after === 0) reasons.push(HOLD_ZERO);
  if (guard.holdLargeChange && Math.abs(after - before) > guard.largeChangeThreshold) reasons.push(HOLD_LARGE);
  if (guard.holdPercentChange && after !== before) {
    const overPercent = before === 0 || (Math.abs(after - before) / Math.abs(before)) * 100 > guard.percentChangeThreshold;
    if (overPercent) reasons.push(HOLD_PERCENT);
  }
  return reasons;
}

/**
 * Works out, for headers whose amount counts as changed, what would happen to
 * their deals. Only reads from HubSpot.
 *
 * Returns { updates, held, closedSkipped }: updates is a Map of deal ID to the
 * change that goes ahead, held the changes the guard holds for review, and
 * closedSkipped the changes left alone because the deal is closed
 * (skipClosedDeals). Deals already in sync and the skipped cases are counted
 * in stats.
 */
export async function evaluateDealChanges(ctx, headers, { plannedLinks = [], withDealState = false } = {}, stats) {
  const { api, mapping } = ctx;
  const cfg = mapping.dealAmount;
  const headerObj = mapping.objects[cfg.header];
  const dealObj = mapping.objects[cfg.deal];
  const headerAmountProp = headerObj.properties.amount;
  const dealAmountProp = dealObj.properties.amount;
  const closedProp = dealObj.properties.isClosed;
  const updates = new Map();
  const held = [];
  const closedSkipped = [];
  if (headers.length === 0) return { updates, held, closedSkipped };

  const dealsByHeader = new Map();
  const existing = await api.readAssociations(headerObj.objectType, dealObj.objectType, headers.map((h) => h.id));
  for (const [headerId, list] of existing) dealsByHeader.set(headerId, new Set(list.map((a) => a.id)));
  for (const link of plannedLinks) {
    if (dealsByHeader.has(link.fromId)) dealsByHeader.get(link.fromId).add(link.toId);
  }

  const dealIds = [...new Set([...dealsByHeader.values()].flatMap((set) => [...set]))];
  const headersByDeal = new Map();
  if (cfg.requireOneToOne && dealIds.length) {
    const reverse = await api.readAssociations(dealObj.objectType, headerObj.objectType, dealIds);
    for (const [dealId, list] of reverse) headersByDeal.set(dealId, new Set(list.map((a) => a.id)));
    for (const link of plannedLinks) {
      if (headersByDeal.has(link.toId)) headersByDeal.get(link.toId).add(link.fromId);
    }
  }

  const readClosed = closedProp && (cfg.skipClosedDeals || withDealState);
  const dealProps = [dealAmountProp, ...(readClosed ? [closedProp] : [])];
  const deals = new Map((await api.batchRead(dealObj.objectType, dealIds, dealProps)).map((d) => [d.id, d]));
  const isClosed = (deal) => String(deal.properties?.[closedProp]).toLowerCase() === 'true';

  for (const header of headers) {
    const linked = [...(dealsByHeader.get(header.id) || [])];
    if (linked.length === 0) {
      stats.skipped.no_deal += 1;
      continue;
    }
    if (cfg.requireOneToOne && linked.length > 1) {
      stats.skipped.header_has_multiple_deals += 1;
      continue;
    }
    const headerAmount = header.properties?.[headerAmountProp];
    if (toNumber(headerAmount) === null) {
      stats.skipped.header_amount_blank += 1;
      continue;
    }
    for (const dealId of linked) {
      if (cfg.requireOneToOne && (headersByDeal.get(dealId)?.size || 0) > 1) {
        stats.skipped.deal_has_multiple_headers += 1;
        continue;
      }
      const deal = deals.get(dealId);
      if (!deal) {
        stats.skipped.deal_not_found += 1;
        continue;
      }
      const dealAmount = deal.properties?.[dealAmountProp];
      if (sameAmount(headerAmount, dealAmount)) {
        stats.inSync += 1;
        continue;
      }
      const change = {
        dealId,
        headerId: header.id,
        from: amountText(dealAmount),
        to: amountText(headerAmount),
      };
      if (withDealState && closedProp) change.dealClosed = isClosed(deal);
      if (cfg.skipClosedDeals && isClosed(deal)) {
        stats.skipped.deal_closed += 1;
        closedSkipped.push(change);
        continue;
      }
      const reasons = guardReasons(cfg, change);
      if (reasons.length) held.push({ ...change, reasons });
      else updates.set(dealId, change);
    }
  }
  return { updates, held, closedSkipped };
}

/**
 * Item B3. When a quote header's amount changes, set the amount on the
 * associated deal to the header amount. Amount is the only deal field written.
 *
 * How a change is recognised (trigger "header_amount_changed"): the amount
 * last seen on each header is kept in the staging database (baseline). A
 * header seen for the first time only gets its amount recorded. A header
 * whose amount differs from the recorded one has changed, and its deal is
 * updated. HubSpot's own property history is not used because the header
 * amount in this portal is a rollup and its history is mostly empty.
 *
 * With requireNewLines, a changed amount only reaches the deal when the
 * header gained a new line (newLines). A change without one is recorded and
 * left alone. Closed deals are left alone with skipClosedDeals.
 *
 * A change the guard holds (see guardReasons) is not applied. It is returned
 * in stats.held, and the caller keeps it on the review list and passes its
 * header in `forced` on every later run, so it is looked at again until the
 * guard lets it through or it no longer applies.
 *
 * - headers: quote header records to look at.
 * - baseline: { headerId: amount } from the staging database.
 * - recordOnly: header IDs whose new amount is recorded without updating the
 *   deal (lines linked while the backlog was being cleared).
 * - newLines: header IDs that gained a line in this run, or in an earlier
 *   run recently enough that the amount change counts as caused by it.
 * - forced: header IDs with a change held on an earlier run; they are looked
 *   at again whether or not their amount changed since.
 * - backfill: treat every header as changed (one-off catch-up; also what the
 *   "any_difference" trigger does on every run).
 * - plannedLinks: header -> deal associations a dry run would have created, so
 *   the dry-run report shows the same deals a live run would reach.
 * - limit: update at most this many deals.
 *
 * Returns { baseline: amounts to record, recheck: header IDs to look at again
 * next run because their deal update failed or was held back by the limit,
 * applied: deal IDs updated (or, in a dry run, that would be), evaluated:
 * header IDs whose change was looked at in this run }.
 */
export async function syncDealAmounts(ctx, headers, { baseline = {}, recordOnly = new Set(), newLines = new Set(), forced = new Set(), backfill = false, plannedLinks = [], limit = null } = {}, stats = newDealAmountStats()) {
  const { api, mapping } = ctx;
  const cfg = mapping.dealAmount;
  const headerObj = mapping.objects[cfg.header];
  const dealObj = mapping.objects[cfg.deal];
  const headerAmountProp = headerObj.properties.amount;
  const dealAmountProp = dealObj.properties.amount;
  const everyHeader = backfill || cfg.trigger === 'any_difference';

  const nextBaseline = {};
  const recheck = [];
  const applied = new Set();
  const evaluated = new Set();
  stats.headersChecked += headers.length;

  const qualifying = [];
  let changed = 0;
  for (const header of headers) {
    const current = amountText(header.properties?.[headerAmountProp]);
    const known = Object.hasOwn(baseline, header.id);
    const differs = known && !sameAmount(baseline[header.id], current);
    nextBaseline[header.id] = current;
    if (everyHeader) {
      qualifying.push(header);
    } else if (forced.has(header.id)) {
      qualifying.push(header);
      if (differs) changed += 1;
    } else if (recordOnly.has(header.id)) {
      if (!known || differs) stats.headersRecordedOnly += 1;
    } else if (!known) {
      stats.headersFirstSeen += 1;
    } else if (differs) {
      changed += 1;
      if (cfg.requireNewLines && !newLines.has(header.id)) stats.headersChangedWithoutNewLines += 1;
      else qualifying.push(header);
    }
  }
  if (!everyHeader) stats.headersWithAmountChange += changed;
  if (qualifying.length === 0) return { baseline: nextBaseline, recheck, applied, evaluated };
  for (const header of qualifying) evaluated.add(header.id);

  const { updates, held, closedSkipped } = await evaluateDealChanges(ctx, qualifying, { plannedLinks }, stats);
  stats.held.push(...held);
  stats.heldCount += held.length;
  for (const change of closedSkipped) if (stats.closedSkipped.length < MAX_CHANGE_ROWS) stats.closedSkipped.push(change);
  if (updates.size === 0) return { baseline: nextBaseline, recheck, applied, evaluated };

  // Keep the old baseline so the change is still seen as a change next run.
  const keepForNextRun = (change) => {
    nextBaseline[change.headerId] = Object.hasOwn(baseline, change.headerId) ? baseline[change.headerId] : '';
    recheck.push(change.headerId);
  };
  let selected = [...updates.values()];
  if (limit && selected.length > limit) {
    for (const change of selected.slice(limit)) {
      stats.notAttempted += 1;
      // A header with no recorded amount yet (catch-up run) is not carried
      // over: a later scheduled run must not finish the catch-up by itself.
      if (Object.hasOwn(baseline, change.headerId)) keepForNextRun(change);
    }
    selected = selected.slice(0, limit);
  }

  const inputs = selected.map((u) => ({ id: u.dealId, properties: { [dealAmountProp]: u.to } }));
  const failed = new Map((await api.updateObjects(dealObj.objectType, inputs)).map((f) => [String(f.id), f.error]));
  for (const change of selected) {
    if (failed.has(change.dealId)) {
      stats.failed += 1;
      stats.failures.push({ ...change, error: failed.get(change.dealId) });
      keepForNextRun(change);
      continue;
    }
    if (api.dryRun) stats.planned += 1;
    else stats.updated += 1;
    applied.add(change.dealId);
    if (stats.changes.length < MAX_CHANGE_ROWS) stats.changes.push(change);
  }
  return { baseline: nextBaseline, recheck, applied, evaluated };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Dry-run projection. Linking lines to a quote header changes the header's
 * amount, but only once HubSpot has recalculated it after the lines are
 * really linked. This works out the amount each header would have (the sum
 * of the amounts of the lines it has now plus the lines this run would link)
 * and what Item B3 would then do with its deal, guard included.
 *
 * Only reads from HubSpot and writes nothing anywhere.
 *
 * lineLinks: the planned line -> header associations of this run.
 */
export async function projectLinkedLineAmounts(ctx, { lineLinks, plannedDealLinks = [] }) {
  const { api, mapping } = ctx;
  const cfg = mapping.dealAmount;
  const rule = mapping.rules.find((r) => r.id === cfg.amountDependsOnRule);
  const headerObj = mapping.objects[cfg.header];
  const lineObj = mapping.objects[rule.from];
  const headerAmountProp = headerObj.properties.amount;
  const lineAmountProp = lineObj.properties[cfg.projection.lineAmount];

  const linesByHeader = new Map();
  for (const link of lineLinks) {
    if (!linesByHeader.has(link.toId)) linesByHeader.set(link.toId, new Set());
    linesByHeader.get(link.toId).add(link.fromId);
  }
  const headerIds = [...linesByHeader.keys()];
  const projection = {
    headersGainingLines: headerIds.length,
    linesToLink: lineLinks.length,
    headersWithAmountChange: 0,
    headersUnchanged: 0,
    inSync: 0,
    wouldUpdate: 0,
    heldCount: 0,
    closedSkippedCount: 0,
    skipped: { no_deal: 0, header_has_multiple_deals: 0, deal_has_multiple_headers: 0, header_amount_blank: 0, deal_closed: 0, deal_not_found: 0 },
    changes: [],
  };
  if (headerIds.length === 0) return projection;

  const already = await api.readAssociations(headerObj.objectType, lineObj.objectType, headerIds);
  for (const [headerId, list] of already) for (const a of list) linesByHeader.get(headerId)?.add(a.id);
  const lineIds = [...new Set([...linesByHeader.values()].flatMap((set) => [...set]))];
  const lineAmount = new Map((await api.batchRead(lineObj.objectType, lineIds, [lineAmountProp])).map((l) => [l.id, toNumber(l.properties?.[lineAmountProp]) ?? 0]));
  const headers = new Map((await api.batchRead(headerObj.objectType, headerIds, [headerAmountProp])).map((h) => [h.id, h]));

  const changedHeaders = [];
  const amountNow = new Map();
  for (const headerId of headerIds) {
    const header = headers.get(headerId);
    if (!header) continue;
    const projected = round2([...linesByHeader.get(headerId)].reduce((sum, lineId) => sum + (lineAmount.get(lineId) ?? 0), 0));
    const current = amountText(header.properties?.[headerAmountProp]);
    if (toNumber(current) !== null && sameAmount(current, projected)) {
      projection.headersUnchanged += 1;
      continue;
    }
    projection.headersWithAmountChange += 1;
    amountNow.set(headerId, current);
    changedHeaders.push({ id: headerId, properties: { [headerAmountProp]: String(projected) } });
  }

  const { updates, held, closedSkipped } = await evaluateDealChanges(ctx, changedHeaders, { plannedLinks: plannedDealLinks, withDealState: true }, projection);
  const row = (change, reasons, skippedClosed = false) => ({ ...change, headerAmountNow: amountNow.get(change.headerId) ?? '', held: reasons.length > 0, reasons, skippedClosed });
  projection.changes = [
    ...[...updates.values()].map((c) => row(c, [])),
    ...held.map(({ reasons, ...c }) => row(c, reasons)),
    ...closedSkipped.map((c) => row(c, [], true)),
  ];
  projection.wouldUpdate = updates.size;
  projection.heldCount = held.length;
  projection.closedSkippedCount = closedSkipped.length;
  return projection;
}
