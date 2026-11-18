import { insertActions, markMissingByIds, replaceAssociations, saveReviewItems } from '../db/store.js';
import { describeRawKey, matchRule } from './match.js';

const MAX_UNRESOLVED_ROWS = 100_000;

export function newRuleStats(rule) {
  return {
    id: rule.id,
    item: rule.item || '',
    label: rule.label,
    sources: 0,
    missingKey: 0,
    noTarget: 0,
    noMatchButAssociated: 0,
    multipleTargets: 0,
    multipleTargetKeys: 0,
    multipleTargetsAlreadyAssociated: 0,
    alreadyAssociated: 0,
    associatedElsewhere: 0,
    addedAlongsideOther: 0,
    created: 0,
    createdUnverified: 0,
    planned: 0,
    failed: 0,
    gone: 0,
    notAttempted: 0,
    associationsCreated: 0,
    associationsPlanned: 0,
    associationsFailed: 0,
    associationsRead: 0,
    unresolved: [],
    unresolvedTruncated: false,
    links: [],
  };
}

function noteUnresolved(stats, id, status, key, detail) {
  if (stats.unresolved.length >= MAX_UNRESOLVED_ROWS) {
    stats.unresolvedTruncated = true;
    return;
  }
  stats.unresolved.push({ id, status, key, detail: detail || '' });
}

const pairKey = (fromType, toType) => `${fromType}>${toType}`;

function setFor(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

/**
 * Applies one association rule.
 *
 * 1. The staging database matches every source record to its target by the
 *    Epicor IDs (match.js) and says which associations it already knows of.
 * 2. For every record that looks unassociated, was just created or modified,
 *    or (on a refresh run) for every matched record, the associations are
 *    read from HubSpot again. HubSpot is the authority; the staging copy is
 *    only used to avoid re-reading what cannot have changed.
 * 3. Only what is missing is created. Nothing existing is changed or removed.
 * 4. On a live run the result is read back from HubSpot to confirm it.
 *
 * run: { runId, startedAt, refresh, changed, arrived, limit, persist, planned, refreshed }
 * Returns { links, touchedTargets, newLinkTargets, arrivedTargets }. arrivedTargets
 * are the targets matched by a source record that arrived since the previous
 * run (run.arrived), whether or not HubSpot had already associated the two.
 */
export async function processRule(ctx, rule, run, stats) {
  const { api, db, mapping } = ctx;
  const fromObj = mapping.objects[rule.from];
  const toObj = mapping.objects[rule.to];
  const fromProps = rule.match.map((m) => fromObj.properties[m.from]);
  const toLabel = toObj.label || rule.to;
  const pair = pairKey(fromObj.objectType, toObj.objectType);
  const changedSources = run.changed?.[rule.from] || new Map();
  const arrivedSources = run.arrived?.[rule.from] || new Set();
  const planned = run.planned.get(pair) || new Map();
  const refreshed = setFor(run.refreshed, pair);

  const links = [];
  const touchedTargets = new Set();
  const newLinkTargets = new Set();
  const arrivedTargets = new Set();
  const multiKeys = new Set();
  // With ifNoMatch "ignore_if_associated" (a second way of finding the same
  // parent, such as the quote number on deals) a record without a match is
  // only reported when it has no parent of that type at all.
  const quiet = rule.ifNoMatch === 'ignore_if_associated';
  const undecided = [];

  const rows = await matchRule(db, mapping, rule);
  stats.sources = rows.length;

  const expected = [];
  for (const row of rows) {
    const key = describeRawKey(fromProps, row.raw);
    if (row.missingKey) {
      stats.missingKey += 1;
      noteUnresolved(stats, row.id, 'missing_key', key);
    } else if (row.targetIds.length === 0) {
      if (quiet) {
        undecided.push({ row, key, status: 'no_target' });
      } else {
        stats.noTarget += 1;
        noteUnresolved(stats, row.id, 'no_target', key, `no ${toLabel} found`);
      }
    } else if (row.targetIds.length > 1 && rule.onMultipleTargets === 'skip') {
      stats.multipleTargets += 1;
      multiKeys.add((row.raw || []).map((v) => String(v ?? '').trim().toLowerCase()).join('\u0000'));
      if (quiet) undecided.push({ row, key, status: 'multiple_targets' });
      else noteUnresolved(stats, row.id, 'multiple_targets', key, `matches ${toLabel} ${row.targetIds.join(', ')}`);
    } else {
      expected.push(row);
      if (changedSources.has(row.id)) for (const id of row.targetIds) touchedTargets.add(id);
      if (arrivedSources.has(row.id)) for (const id of row.targetIds) arrivedTargets.add(id);
    }
  }
  stats.multipleTargetKeys = multiKeys.size;

  const needsLiveRead = (row) => {
    if (run.refresh || changedSources.has(row.id)) return true;
    const known = new Set(row.knownIds);
    return row.targetIds.some((id) => !known.has(id));
  };
  const live = expected.filter(needsLiveRead);
  stats.alreadyAssociated += expected.length - live.length;

  const recheck = undecided.map((entry) => entry.row).filter((row) => run.refresh || changedSources.has(row.id));
  const toRead = [...live, ...recheck].map((row) => row.id).filter((id) => !refreshed.has(id));
  const fresh = toRead.length ? await api.readAssociations(fromObj.objectType, toObj.objectType, toRead) : new Map();
  if (toRead.length) {
    await replaceAssociations(db, { fromType: fromObj.objectType, toType: toObj.objectType, fromIds: toRead, map: fresh, now: run.startedAt });
    for (const id of toRead) refreshed.add(id);
    stats.associationsRead += toRead.length;
  }

  const current = (row) => {
    const have = new Set(fresh.has(row.id) ? fresh.get(row.id).map((a) => a.id) : row.knownIds);
    // Associations an earlier rule of this dry run would have created count as existing.
    for (const id of planned.get(row.id) || []) have.add(id);
    return have;
  };

  for (const { row, key, status } of undecided) {
    const have = current(row);
    if (status === 'multiple_targets') {
      if (have.size) stats.multipleTargetsAlreadyAssociated += 1;
      noteUnresolved(stats, row.id, 'multiple_targets', key,
        `matches ${toLabel} ${row.targetIds.join(', ')}${have.size ? `; already has ${toLabel} ${[...have].join(', ')}` : ''}`);
    } else if (have.size) {
      stats.noMatchButAssociated += 1;
    } else {
      stats.noTarget += 1;
      noteUnresolved(stats, row.id, 'no_target', key, `no ${toLabel} found`);
    }
  }

  const withGaps = [];
  const toCreate = [];
  for (const row of live) {
    const have = current(row);
    const missing = row.targetIds.filter((id) => !have.has(id));
    const hasOther = have.size > 0 && missing.length === row.targetIds.length;
    if (missing.length === 0) {
      stats.alreadyAssociated += 1;
    } else if (hasOther && rule.ifAssociatedElsewhere === 'skip') {
      // Associated to some other record of this type, but not the one its key points to.
      stats.associatedElsewhere += 1;
      noteUnresolved(stats, row.id, 'associated_elsewhere', describeRawKey(fromProps, row.raw),
        `has ${toLabel} ${[...have].join(', ')}; key matches ${row.targetIds.join(', ')}`);
    } else if (run.limit && withGaps.length >= run.limit) {
      stats.notAttempted += 1;
    } else {
      if (hasOther) stats.addedAlongsideOther += 1;
      withGaps.push({ row, missing });
      for (const toId of missing) toCreate.push({ fromId: row.id, toId });
    }
  }

  if (toCreate.length > 0) {
    const troubled = await api.createAssociations(fromObj.objectType, toObj.objectType, toCreate, rule.association);

    if (api.dryRun) {
      if (!run.planned.has(pair)) run.planned.set(pair, planned);
      for (const { row, missing } of withGaps) {
        stats.planned += 1;
        stats.associationsPlanned += missing.length;
        for (const toId of missing) {
          links.push({ fromId: row.id, toId, planned: true });
          setFor(planned, row.id).add(toId);
        }
      }
    } else {
      await confirmCreated(ctx, rule, run, stats, { withGaps, troubled, links, newLinkTargets });
    }
  }

  if (links.length) {
    await insertActions(db, { runId: run.runId, ruleId: rule.id, fromType: fromObj.objectType, toType: toObj.objectType, links, now: run.startedAt });
  }
  if (run.persist) {
    await saveReviewItems(db, { ruleId: rule.id, items: stats.unresolved, now: run.startedAt });
  }
  for (const id of newLinkTargets) touchedTargets.add(id);
  for (const id of arrivedTargets) touchedTargets.add(id);
  return { links, touchedTargets, newLinkTargets, arrivedTargets };
}

/** Reads back what HubSpot now holds rather than trusting the batch response. */
async function confirmCreated(ctx, rule, run, stats, { withGaps, troubled, links, newLinkTargets }) {
  const { api, db, mapping } = ctx;
  const fromObj = mapping.objects[rule.from];
  const toObj = mapping.objects[rule.to];
  const fromProps = rule.match.map((m) => fromObj.properties[m.from]);
  const toLabel = toObj.label || rule.to;

  const troubledPairs = new Map();
  for (const group of troubled) {
    for (const p of group.pairs) troubledPairs.set(`${p.fromId}:${p.toId}`, group.error);
  }
  const ids = withGaps.map((entry) => entry.row.id);
  const after = await api.readAssociations(fromObj.objectType, toObj.objectType, ids);
  await replaceAssociations(db, { fromType: fromObj.objectType, toType: toObj.objectType, fromIds: ids, map: after, now: run.startedAt });

  const failedEntries = [];
  for (const entry of withGaps) {
    const have = new Set((after.get(entry.row.id) || []).map((a) => a.id));
    entry.failedTargets = [];
    let unverified = 0;
    for (const toId of entry.missing) {
      if (have.has(toId)) {
        stats.associationsCreated += 1;
        links.push({ fromId: entry.row.id, toId, planned: false });
        newLinkTargets.add(toId);
      } else if (troubledPairs.has(`${entry.row.id}:${toId}`)) {
        entry.failedTargets.push(toId);
        entry.error = troubledPairs.get(`${entry.row.id}:${toId}`);
      } else {
        unverified += 1;
      }
    }
    if (entry.failedTargets.length) failedEntries.push(entry);
    else if (unverified > 0) stats.createdUnverified += 1;
    else stats.created += 1;
  }
  if (failedEntries.length === 0) return;

  // A create can fail because a record was deleted or merged in HubSpot after
  // it was copied into the staging database. That is not an error to alert on:
  // the staging row is marked as gone and the record is treated accordingly.
  const sourceIds = failedEntries.map((entry) => entry.row.id);
  const targetIds = [...new Set(failedEntries.flatMap((entry) => entry.failedTargets))];
  const presentSources = new Set((await api.batchRead(fromObj.objectType, sourceIds, [])).map((r) => String(r.id)));
  const presentTargets = new Set((await api.batchRead(toObj.objectType, targetIds, [])).map((r) => String(r.id)));
  await markMissingByIds(db, { objectKey: rule.from, ids: sourceIds.filter((id) => !presentSources.has(id)), now: run.startedAt });
  await markMissingByIds(db, { objectKey: rule.to, ids: targetIds.filter((id) => !presentTargets.has(id)), now: run.startedAt });

  for (const entry of failedEntries) {
    const key = describeRawKey(fromProps, entry.row.raw);
    if (!presentSources.has(entry.row.id)) {
      stats.gone += 1;
    } else if (entry.failedTargets.every((id) => !presentTargets.has(id))) {
      stats.noTarget += 1;
      noteUnresolved(stats, entry.row.id, 'no_target', key, `the matching ${toLabel} no longer exists in HubSpot`);
    } else {
      stats.failed += 1;
      stats.associationsFailed += entry.failedTargets.filter((id) => presentTargets.has(id)).length;
      noteUnresolved(stats, entry.row.id, 'failed', key, entry.error);
    }
  }
}
