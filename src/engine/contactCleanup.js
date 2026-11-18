import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireRunLock,
  finishRun,
  getRun,
  insertRemovals,
  insertRun,
  markRemovalsRestored,
  releaseRunLock,
  removalsForRun,
  setRemovalResults,
} from '../db/store.js';
import { chunk, runStamp } from '../util.js';
import { ingestAll } from './ingest.js';
import { describeRawKey, matchRule } from './match.js';
import { startLockHeartbeat } from './run.js';

const CHUNK = 1000;

function newCleanupSummary(runId, dryRun, limit, startedAt, standardContacts) {
  return {
    runId,
    mode: 'cleanup-contacts',
    command: 'cleanup-contacts',
    item: 'B2',
    dryRun,
    limit,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    status: 'failed',
    headersScanned: 0,
    headersWithContacts: 0,
    headersChanged: 0,
    headersNotAttempted: 0,
    headersSkipped: {
      missing_quote_contact_number: 0,
      named_contact_not_found: 0,
      named_contact_ambiguous: 0,
    },
    associationsSeen: 0,
    associationsKept: 0,
    associationsLeftOnSkippedHeaders: 0,
    associationsPreservedOtherTypes: 0,
    associationsToRemove: 0,
    associationsRemoved: 0,
    associationsFailed: 0,
    standardContacts: standardContacts
      ? {
        enabled: true,
        headersWithContacts: 0,
        headersSkipped: { no_standard_contact_for_named_contact: 0 },
        associationsSeen: 0,
        associationsKept: 0,
        associationsLeftOnSkippedHeaders: 0,
        associationsPreservedOtherTypes: 0,
        associationsToRemove: 0,
        associationsRemoved: 0,
        associationsFailed: 0,
      }
      : { enabled: false },
    backupFile: null,
    stateSaved: false,
    error: null,
  };
}

const plainTypes = (types) => (types || []).map((t) => ({ category: t.category, typeId: t.typeId, label: t.label ?? null }));

/**
 * Item B2 one-time cleanup. Removes contact associations on quote headers
 * where the contact is not the one named on the quote (matched on quote
 * contact number, the same rule the middleware uses to associate).
 *
 * A header is only touched when its quote contact number is filled in and,
 * unless requireNamedContactFound is false, the named contact exists in
 * HubSpot. The named contact is found by matching in the staging database.
 *
 * Standard Contact associations on the same headers are only touched when
 * contactCleanup.standardContacts.enabled is true (off by default). With
 * keepLinkedToNamedContact the standard Contact(s) associated to the named
 * contact record are kept; a header whose named contact has no standard
 * Contact is left alone.
 *
 * Every association removed (or, in dry run, that would be removed) is first
 * written, with its association types, to the staging database and to a
 * backup file, so it can be put back with `cleanup-contacts --restore`.
 */
export async function runContactCleanup(ctx, { limit = null, outputDir } = {}) {
  const { api, db, mapping, settings, logger } = ctx;
  const cfg = mapping.contactCleanup;
  const rule = mapping.rules.find((r) => r.id === cfg.rule);
  const headerObj = mapping.objects[rule.from];
  const contactObj = mapping.objects[rule.to];
  const headerProps = rule.match.map((m) => headerObj.properties[m.from]);
  const onlyTypes = cfg.removeOnlyTypeIds ? new Set(cfg.removeOnlyTypeIds) : null;
  const std = cfg.standardContacts.enabled ? cfg.standardContacts : null;
  const stdObj = std ? mapping.objects[std.object] : null;
  const stdOnlyTypes = std?.removeOnlyTypeIds ? new Set(std.removeOnlyTypeIds) : null;

  const now = ctx.now || (() => new Date());
  const startedAt = now();
  const summary = newCleanupSummary(crypto.randomUUID(), api.dryRun, limit, startedAt, std);
  let locked = false;
  let heartbeat = null;
  let recorded = false;

  const removeAndConfirm = async (toType, removals, counters) => {
    if (removals.length === 0) return;
    counters.associationsToRemove += removals.length;
    await insertRemovals(db, {
      runId: summary.runId,
      now: startedAt,
      rows: removals.map((r) => ({ ...r, fromType: headerObj.objectType, toType, result: api.dryRun ? 'planned' : 'pending' })),
    });
    fs.appendFileSync(summary.backupFile, removals.map((r) => JSON.stringify({ ...r, toObjectType: toType })).join('\n') + '\n');

    const pairs = removals.map((r) => ({ fromId: r.headerId, toId: r.toId }));
    const troubled = await api.archiveAssociations(headerObj.objectType, toType, pairs);
    if (api.dryRun) return;

    for (const group of troubled) logger.warn('contact cleanup batch reported errors', { error: group.error, pairs: group.pairs.length });
    const after = await api.readAssociations(headerObj.objectType, toType, [...new Set(pairs.map((p) => p.fromId))]);
    const removed = [];
    const failed = [];
    for (const pair of pairs) {
      const still = (after.get(pair.fromId) || []).some((a) => a.id === pair.toId);
      (still ? failed : removed).push(pair);
    }
    counters.associationsRemoved += removed.length;
    counters.associationsFailed += failed.length;
    await setRemovalResults(db, { runId: summary.runId, toType, pairs: removed, result: 'removed' });
    await setRemovalResults(db, { runId: summary.runId, toType, pairs: failed, result: 'failed' });
  };

  const processChunk = async (rows) => {
    summary.headersScanned += rows.length;
    const ids = rows.map((row) => row.id);
    const existing = await api.readAssociations(headerObj.objectType, contactObj.objectType, ids);
    const existingStd = std ? await api.readAssociations(headerObj.objectType, stdObj.objectType, ids) : new Map();

    const eligible = [];
    for (const row of rows) {
      const associated = existing.get(row.id) || [];
      const associatedStd = existingStd.get(row.id) || [];
      if (associated.length) summary.headersWithContacts += 1;
      if (std && associatedStd.length) summary.standardContacts.headersWithContacts += 1;
      if (associated.length === 0 && associatedStd.length === 0) continue;
      summary.associationsSeen += associated.length;
      if (std) summary.standardContacts.associationsSeen += associatedStd.length;

      let skip = null;
      if (row.missingKey) skip = 'missing_quote_contact_number';
      else if (row.targetIds.length === 0 && cfg.requireNamedContactFound) skip = 'named_contact_not_found';
      else if (row.targetIds.length > 1 && rule.onMultipleTargets === 'skip') skip = 'named_contact_ambiguous';
      if (skip) {
        summary.headersSkipped[skip] += 1;
        summary.associationsLeftOnSkippedHeaders += associated.length;
        if (std) summary.standardContacts.associationsLeftOnSkippedHeaders += associatedStd.length;
        continue;
      }
      eligible.push({ row, associated, associatedStd });
    }
    if (eligible.length === 0) return;

    // Standard Contacts to keep: the ones associated to the named contact record.
    let stdOfNamed = new Map();
    if (std?.keepLinkedToNamedContact) {
      const named = [...new Set(eligible.filter((e) => e.associatedStd.length).flatMap((e) => e.row.targetIds))];
      if (named.length) stdOfNamed = await api.readAssociations(contactObj.objectType, stdObj.objectType, named);
    }

    const removals = [];
    const stdRemovals = [];
    for (const { row, associated, associatedStd } of eligible) {
      const headerKey = describeRawKey(headerProps, row.raw);
      const mine = [];
      const mineStd = [];
      const tally = { kept: 0, preserved: 0, stdKept: 0, stdPreserved: 0, stdSkipped: false };

      const keep = new Set(row.targetIds);
      for (const assoc of associated) {
        if (keep.has(assoc.id)) tally.kept += 1;
        else if (onlyTypes && !assoc.types.every((t) => onlyTypes.has(t.typeId))) tally.preserved += 1;
        else mine.push({ headerId: row.id, headerKey, toId: assoc.id, types: plainTypes(assoc.types) });
      }

      if (std && associatedStd.length) {
        const keepStd = new Set();
        if (std.keepLinkedToNamedContact) {
          for (const namedId of row.targetIds) for (const a of stdOfNamed.get(namedId) || []) keepStd.add(a.id);
        }
        if (std.keepLinkedToNamedContact && keepStd.size === 0) {
          // Nothing says which standard Contact is the named one, so none is removed.
          tally.stdSkipped = true;
        } else {
          for (const assoc of associatedStd) {
            if (keepStd.has(assoc.id)) tally.stdKept += 1;
            else if (stdOnlyTypes && !assoc.types.every((t) => stdOnlyTypes.has(t.typeId))) tally.stdPreserved += 1;
            else mineStd.push({ headerId: row.id, headerKey, toId: assoc.id, types: plainTypes(assoc.types) });
          }
        }
      }

      const changes = mine.length + mineStd.length > 0;
      if (changes && limit && summary.headersChanged >= limit) {
        summary.headersNotAttempted += 1;
        continue;
      }
      if (changes) summary.headersChanged += 1;
      summary.associationsKept += tally.kept;
      summary.associationsPreservedOtherTypes += tally.preserved;
      if (std) {
        summary.standardContacts.associationsKept += tally.stdKept;
        summary.standardContacts.associationsPreservedOtherTypes += tally.stdPreserved;
        if (tally.stdSkipped) {
          summary.standardContacts.headersSkipped.no_standard_contact_for_named_contact += 1;
          summary.standardContacts.associationsLeftOnSkippedHeaders += associatedStd.length;
        }
      }
      removals.push(...mine);
      stdRemovals.push(...mineStd);
    }

    await removeAndConfirm(contactObj.objectType, removals, summary);
    if (std) await removeAndConfirm(stdObj.objectType, stdRemovals, summary.standardContacts);
  };

  try {
    if (!api.dryRun) {
      locked = await acquireRunLock(db, { holder: summary.runId, now: startedAt, staleAfterMs: settings.runLockStaleMinutes * 60_000 });
      if (!locked) {
        summary.status = 'skipped';
        summary.error = 'another live run holds the run lock';
        summary.finishedAt = now().toISOString();
        return summary;
      }
      heartbeat = startLockHeartbeat(db, summary.runId, now);
    }
    await insertRun(db, summary);
    recorded = true;

    fs.mkdirSync(outputDir, { recursive: true });
    summary.backupFile = path.join(outputDir, `contact-cleanup-${runStamp(startedAt)}-${summary.runId.slice(0, 8)}${api.dryRun ? '-dryrun' : ''}.jsonl`);
    fs.writeFileSync(summary.backupFile, '');

    await ingestAll(ctx, [rule.from, rule.to], { full: true, runId: summary.runId, startedAt });
    const rows = await matchRule(db, mapping, rule);
    for (const group of chunk(rows, CHUNK)) await processChunk(group);

    const failed = summary.associationsFailed + (std ? summary.standardContacts.associationsFailed : 0);
    summary.status = failed > 0 ? 'completed_with_errors' : 'ok';
    summary.stateSaved = !api.dryRun;
  } catch (err) {
    summary.status = 'failed';
    summary.error = err?.message || String(err);
    logger.error('contact cleanup failed', { error: summary.error });
  }
  summary.finishedAt = now().toISOString();
  summary.api = { ...api.client.stats };
  try {
    if (recorded) await finishRun(db, summary, { compact: summary });
  } catch (err) {
    logger.error('could not store the cleanup result in the staging database', { error: err?.message || String(err) });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) await releaseRunLock(db, summary.runId).catch(() => {});
  }
  return summary;
}

function readBackupFile(file, defaultToType) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => {
    const row = JSON.parse(line);
    return {
      headerId: String(row.headerId),
      toId: String(row.toId ?? row.contactId),
      toType: row.toObjectType || defaultToType,
      types: row.types || [],
    };
  });
}

/**
 * Puts back associations a cleanup removed, with the types they had. The
 * source is either a cleanup run ID (rows kept in the staging database) or a
 * backup file written by the cleanup.
 */
export async function restoreContactAssociations(ctx, { runId = null, file = null }) {
  const { api, db, mapping } = ctx;
  const rule = mapping.rules.find((r) => r.id === mapping.contactCleanup.rule);
  const headerType = mapping.objects[rule.from].objectType;
  const now = ctx.now || (() => new Date());

  const summary = {
    command: 'cleanup-contacts --restore',
    dryRun: api.dryRun,
    source: runId ? `run ${runId}` : file,
    rows: 0,
    restored: 0,
    planned: 0,
    failed: 0,
    status: 'ok',
    error: null,
  };

  let rows;
  if (runId) {
    const run = await getRun(db, runId);
    if (!run || run.mode !== 'cleanup-contacts') {
      summary.status = 'failed';
      summary.error = `no contact cleanup run with ID ${runId} in the staging database`;
      return summary;
    }
    if (run.dryRun) {
      summary.status = 'failed';
      summary.error = 'that cleanup run was a dry run; it removed nothing, so there is nothing to restore';
      return summary;
    }
    rows = (await removalsForRun(db, runId)).filter((r) => (r.result === 'removed' || r.result === 'pending') && !r.restoredAt);
  } else {
    rows = readBackupFile(file, mapping.objects[rule.to].objectType);
  }
  summary.rows = rows.length;

  const groups = new Map();
  for (const row of rows) {
    const signature = `${row.toType}|${JSON.stringify(row.types.map((t) => [t.category, t.typeId]).sort())}`;
    if (!groups.has(signature)) groups.set(signature, { toType: row.toType, types: row.types, pairs: [] });
    groups.get(signature).pairs.push({ fromId: String(row.headerId), toId: String(row.toId) });
  }
  for (const { toType, types, pairs } of groups.values()) {
    const association = types.length ? { types } : 'default';
    await api.createAssociations(headerType, toType, pairs, association);
    if (api.dryRun) {
      summary.planned += pairs.length;
      continue;
    }
    const after = await api.readAssociations(headerType, toType, [...new Set(pairs.map((p) => p.fromId))]);
    const restored = pairs.filter((pair) => (after.get(pair.fromId) || []).some((a) => a.id === pair.toId));
    summary.restored += restored.length;
    summary.failed += pairs.length - restored.length;
    if (runId) await markRemovalsRestored(db, { runId, pairs: restored, toType, now: now() });
  }
  if (summary.failed > 0) summary.status = 'completed_with_errors';
  return summary;
}
