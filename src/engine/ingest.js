import { enabledRules, propertiesFor } from '../config.js';
import { getCursor, markMissing, saveCursor, upsertRecords } from '../db/store.js';

/** Objects that have to be in the staging database: both sides of every enabled rule, plus the deal amount objects. */
export function objectsToIngest(mapping, { extraRules = [] } = {}) {
  const used = new Set();
  for (const rule of [...enabledRules(mapping), ...extraRules]) {
    used.add(rule.from);
    used.add(rule.to);
  }
  if (mapping.dealAmount.enabled) {
    used.add(mapping.dealAmount.header);
    used.add(mapping.dealAmount.deal);
  }
  return Object.keys(mapping.objects).filter((key) => used.has(key));
}

/**
 * Copies one object's records from HubSpot into the staging database.
 *
 * - The first time (or when full is asked for, or when the last full ingest
 *   is older than FULL_REFRESH_HOURS) every record is read, and staging rows
 *   HubSpot no longer returns are marked as missing.
 * - After that only records created or modified since the previous ingest
 *   started are read, with a small overlap because HubSpot's search index
 *   can lag behind.
 *
 * This only reads from HubSpot. It runs in dry runs too: the staging copy is
 * the middleware's own database, not HubSpot.
 */
export async function ingestObject(ctx, objectKey, { full = false, runId, startedAt }) {
  const { api, db, mapping, settings } = ctx;
  const obj = mapping.objects[objectKey];
  const properties = propertiesFor(mapping, objectKey);
  const cursor = await getCursor(db, objectKey);
  const refreshMs = settings.fullRefreshHours > 0 ? settings.fullRefreshHours * 3_600_000 : null;
  const stale = refreshMs !== null && cursor.fullIngestAt && new Date(startedAt).getTime() - new Date(cursor.fullIngestAt).getTime() >= refreshMs;
  const doFull = full || !cursor.fullIngestAt || !cursor.changesSince || Boolean(stale);

  let filterGroups = [];
  let since = null;
  if (!doFull) {
    since = new Date(new Date(cursor.changesSince).getTime() - settings.changeOverlapMinutes * 60_000);
    const value = String(since.getTime());
    filterGroups = [
      { filters: [{ propertyName: obj.createdProperty, operator: 'GTE', value }] },
      { filters: [{ propertyName: obj.modifiedProperty, operator: 'GTE', value }] },
    ];
  }

  // On a full ingest everything is read, but only records created or modified
  // since the previous ingest count as changed.
  const changedFloor = doFull && cursor.changesSince
    ? new Date(cursor.changesSince).getTime() - settings.changeOverlapMinutes * 60_000
    : null;
  const isChanged = (record) => {
    if (!doFull) return true;
    if (changedFloor === null) return false;
    const stamps = [record.properties?.[obj.modifiedProperty], record.properties?.[obj.createdProperty], record.updatedAt, record.createdAt];
    return stamps.some((value) => value && Date.parse(value) >= changedFloor);
  };

  const changed = new Map();
  let read = 0;
  for await (const page of api.searchPages(obj.objectType, { filterGroups, properties })) {
    await upsertRecords(db, { objectKey, objectType: obj.objectType, records: page, runId, now: startedAt });
    read += page.length;
    for (const record of page) if (isChanged(record)) changed.set(String(record.id), record);
  }

  let markedMissing = 0;
  if (doFull) markedMissing = await markMissing(db, { objectKey, runId, now: startedAt });
  await saveCursor(db, objectKey, { changesSince: startedAt, fullIngestAt: doFull ? startedAt : null });

  return {
    objectKey,
    mode: doFull ? 'full' : 'changes',
    since: since ? since.toISOString() : null,
    records: read,
    changedRecords: changed.size,
    markedMissing,
    changed,
  };
}

export async function ingestAll(ctx, objectKeys, options) {
  const results = {};
  for (const key of objectKeys) {
    results[key] = await ingestObject(ctx, key, options);
    const { changed, ...counts } = results[key];
    ctx.logger?.info('ingested', counts);
  }
  return results;
}
