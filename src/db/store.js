import { chunk } from '../util.js';

// Bulk writes pass their rows as one JSON parameter and unpack it in SQL with
// jsonb_to_recordset. That keeps statements short and behaves the same on
// every Postgres driver.
const BULK = 1000;
const iso = (value) => (value instanceof Date ? value.toISOString() : value);
const idList = (ids) => JSON.stringify([...ids].map(String));
const ID_ARRAY = (n) => `ARRAY(SELECT jsonb_array_elements_text($${n}::jsonb))`;

// ---- staging records -------------------------------------------------------

export async function upsertRecords(db, { objectKey, objectType, records, runId, now }) {
  for (const group of chunk(records, BULK)) {
    const rows = group.map((record) => ({
      hubspot_id: String(record.id),
      properties: { ...(record.properties || {}), hs_object_id: String(record.id) },
      created: record.createdAt || null,
      modified: record.updatedAt || null,
    }));
    await db.query(
      `INSERT INTO staging_records
         (object_key, hubspot_object_type, hubspot_id, source, properties, hs_created_at, hs_modified_at, first_ingested_at, last_ingested_at, last_ingest_run)
       SELECT $1, $2, x.hubspot_id, 'hubspot', x.properties, x.created, x.modified, $4::timestamptz, $4::timestamptz, $5
       FROM jsonb_to_recordset($3::jsonb) AS x(hubspot_id text, properties jsonb, created timestamptz, modified timestamptz)
       ON CONFLICT (object_key, hubspot_id) DO UPDATE SET
         hubspot_object_type = EXCLUDED.hubspot_object_type,
         properties = EXCLUDED.properties,
         hs_created_at = COALESCE(EXCLUDED.hs_created_at, staging_records.hs_created_at),
         hs_modified_at = COALESCE(EXCLUDED.hs_modified_at, staging_records.hs_modified_at),
         last_ingested_at = EXCLUDED.last_ingested_at,
         last_ingest_run = EXCLUDED.last_ingest_run,
         missing_since = NULL`,
      [objectKey, objectType, JSON.stringify(rows), iso(now), runId],
    );
  }
}

/** After a full ingest: rows of this object that HubSpot no longer returned. */
export async function markMissing(db, { objectKey, runId, now }) {
  const result = await db.query(
    `UPDATE staging_records SET missing_since = $3::timestamptz
     WHERE object_key = $1 AND source = 'hubspot' AND missing_since IS NULL AND last_ingest_run IS DISTINCT FROM $2`,
    [objectKey, runId, iso(now)],
  );
  return result.rowCount;
}

/** Marks specific records as gone (HubSpot answered "not found" for them). */
export async function markMissingByIds(db, { objectKey, ids, now }) {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE staging_records SET missing_since = $3::timestamptz
     WHERE object_key = $1 AND missing_since IS NULL AND hubspot_id = ANY(${ID_ARRAY(2)})`,
    [objectKey, idList(ids), iso(now)],
  );
}

export async function countRecords(db, objectKey) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM staging_records WHERE object_key = $1 AND hubspot_id IS NOT NULL AND missing_since IS NULL',
    [objectKey],
  );
  return rows[0].n;
}

/** Pages through an object's staging rows in a stable order. */
export async function* recordPages(db, objectKey, pageSize = BULK) {
  let after = '0';
  for (;;) {
    const { rows } = await db.query(
      `SELECT id::text AS row_id, hubspot_id AS id, properties FROM staging_records
       WHERE object_key = $1 AND hubspot_id IS NOT NULL AND missing_since IS NULL AND id > $2::bigint
       ORDER BY id LIMIT $3`,
      [objectKey, after, pageSize],
    );
    if (rows.length === 0) return;
    yield rows.map((row) => ({ id: row.id, properties: row.properties }));
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1].row_id;
  }
}

export async function getCursor(db, objectKey) {
  const { rows } = await db.query('SELECT changes_since, full_ingest_at FROM ingest_cursors WHERE object_key = $1', [objectKey]);
  return rows[0] ? { changesSince: rows[0].changes_since, fullIngestAt: rows[0].full_ingest_at } : { changesSince: null, fullIngestAt: null };
}

export async function saveCursor(db, objectKey, { changesSince, fullIngestAt = null }) {
  await db.query(
    `INSERT INTO ingest_cursors (object_key, changes_since, full_ingest_at) VALUES ($1, $2::timestamptz, $3::timestamptz)
     ON CONFLICT (object_key) DO UPDATE SET
       changes_since = EXCLUDED.changes_since,
       full_ingest_at = COALESCE(EXCLUDED.full_ingest_at, ingest_cursors.full_ingest_at)`,
    [objectKey, iso(changesSince), iso(fullIngestAt)],
  );
}

/**
 * Item B3, "a line that arrived since the last run". arrivalsSince is the
 * start of the last run that recorded its results and got as far as the deal
 * amounts. Records first copied into staging after it have arrived since.
 * Dry runs and failed runs do not move it, so they do not use up the signal.
 * Null until the first such run: on a new database nothing counts as arrived.
 */
export async function getArrivalsSince(db, objectKey) {
  const { rows } = await db.query('SELECT arrivals_since FROM ingest_cursors WHERE object_key = $1', [objectKey]);
  return rows[0]?.arrivals_since ?? null;
}

export async function saveArrivalsSince(db, objectKey, at) {
  await db.query('UPDATE ingest_cursors SET arrivals_since = $2::timestamptz WHERE object_key = $1', [objectKey, iso(at)]);
}

export async function recordsArrivedSince(db, { objectKey, since }) {
  const { rows } = await db.query(
    `SELECT hubspot_id FROM staging_records
     WHERE object_key = $1 AND missing_since IS NULL AND first_ingested_at > $2::timestamptz`,
    [objectKey, iso(since)],
  );
  return new Set(rows.map((row) => row.hubspot_id));
}

// ---- staging associations --------------------------------------------------

/**
 * Stores what HubSpot returned for the associations of fromIds to records of
 * toType, replacing whatever was stored for those records.
 * map: Map(fromId -> [{ id, types }]).
 */
export async function replaceAssociations(db, { fromType, toType, fromIds, map, now }) {
  for (const group of chunk([...fromIds].map(String), BULK)) {
    const rows = [];
    for (const fromId of group) {
      const seen = new Set();
      for (const to of map.get(fromId) || []) {
        if (seen.has(to.id)) continue;
        seen.add(to.id);
        rows.push({ from_id: fromId, to_id: String(to.id), types: to.types || [] });
      }
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `DELETE FROM staging_associations WHERE from_object_type = $1 AND to_object_type = $2 AND from_id = ANY(${ID_ARRAY(3)})`,
        [fromType, toType, idList(group)],
      );
      for (const part of chunk(rows, BULK * 5)) {
        await tx.query(
          `INSERT INTO staging_associations (from_object_type, to_object_type, from_id, to_id, types, read_at)
           SELECT $1, $2, x.from_id, x.to_id, x.types, $4::timestamptz
           FROM jsonb_to_recordset($3::jsonb) AS x(from_id text, to_id text, types jsonb)`,
          [fromType, toType, JSON.stringify(part), iso(now)],
        );
      }
    });
  }
}

// ---- runs ------------------------------------------------------------------

export async function insertRun(db, summary) {
  await db.query(
    'INSERT INTO runs (id, mode, dry_run, limit_n, started_at, status) VALUES ($1, $2, $3, $4, $5::timestamptz, $6)',
    [summary.runId, summary.mode, summary.dryRun, summary.limit ?? null, summary.startedAt, 'running'],
  );
}

export async function finishRun(db, summary, { compact, reportMarkdown = null }) {
  await db.query(
    `UPDATE runs SET finished_at = $2::timestamptz, status = $3, error = $4, state_saved = $5, summary = $6::jsonb, report_markdown = $7 WHERE id = $1`,
    [summary.runId, summary.finishedAt, summary.status, summary.error || null, Boolean(summary.stateSaved), JSON.stringify(compact), reportMarkdown],
  );
}

function runRow(row) {
  if (!row) return null;
  return {
    runId: row.id,
    mode: row.mode,
    dryRun: row.dry_run,
    limit: row.limit_n,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    error: row.error,
    stateSaved: row.state_saved,
    summary: row.summary,
    reportMarkdown: row.report_markdown,
  };
}

/** The most recent run, optionally of given modes. Runs still in progress are included. */
export async function lastRun(db, { modes = null } = {}) {
  const { rows } = modes
    ? await db.query(`SELECT * FROM runs WHERE mode = ANY(${ID_ARRAY(1)}) ORDER BY started_at DESC, finished_at DESC NULLS FIRST LIMIT 1`, [JSON.stringify(modes)])
    : await db.query('SELECT * FROM runs ORDER BY started_at DESC, finished_at DESC NULLS FIRST LIMIT 1');
  return runRow(rows[0]);
}

/**
 * Link health as the most recent finished run found it (engine/health.js), or
 * null before the first such run. A run in progress or one that failed before
 * the associations were checked has none, so an earlier run's is returned.
 */
export async function lastLinkHealth(db) {
  const { rows } = await db.query(
    `SELECT id, mode, dry_run, limit_n, finished_at, summary->'health' AS health
     FROM runs
     WHERE mode IN ('incremental', 'full') AND finished_at IS NOT NULL AND jsonb_typeof(summary->'health') = 'array'
     ORDER BY started_at DESC, finished_at DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return { runId: row.id, mode: row.mode, dryRun: row.dry_run, limit: row.limit_n, finishedAt: row.finished_at, groups: row.health };
}

export async function getRun(db, id) {
  const { rows } = await db.query('SELECT * FROM runs WHERE id = $1', [id]);
  return runRow(rows[0]);
}

/** True once a live run without a --limit has completed. Before that, the backlog has not been worked through. */
export async function hasCompletedLiveRun(db) {
  const { rows } = await db.query(
    `SELECT 1 FROM runs WHERE state_saved AND NOT dry_run AND limit_n IS NULL AND mode IN ('incremental', 'full') LIMIT 1`,
  );
  return rows.length > 0;
}

export async function pruneRuns(db, before) {
  const result = await db.query(`DELETE FROM runs WHERE started_at < $1::timestamptz AND mode IN ('incremental', 'full')`, [iso(before)]);
  return result.rowCount;
}

/**
 * Runs left in "running" by a process that died. A live run that holds the
 * run lock knows every other live run is dead; dry runs are closed by age.
 */
export async function closeAbandonedRuns(db, { holdsLock, dryRunsBefore, now }) {
  const reason = 'the process stopped before the run finished';
  if (holdsLock) {
    await db.query(
      `UPDATE runs SET status = 'failed', error = $1, finished_at = $2::timestamptz WHERE status = 'running' AND NOT dry_run`,
      [reason, iso(now)],
    );
  }
  await db.query(
    `UPDATE runs SET status = 'failed', error = $1, finished_at = $2::timestamptz WHERE status = 'running' AND started_at < $3::timestamptz`,
    [reason, iso(now), iso(dryRunsBefore)],
  );
}

export async function insertActions(db, { runId, ruleId, fromType, toType, links, now }) {
  for (const group of chunk(links, BULK * 5)) {
    const rows = group.map((link) => ({ from_id: link.fromId, to_id: link.toId, result: link.planned ? 'planned' : 'created' }));
    await db.query(
      `INSERT INTO association_actions (run_id, rule_id, from_object_type, from_id, to_object_type, to_id, result, created_at)
       SELECT $1, $2, $3, x.from_id, $4, x.to_id, x.result, $6::timestamptz
       FROM jsonb_to_recordset($5::jsonb) AS x(from_id text, to_id text, result text)`,
      [runId, ruleId, fromType, toType, JSON.stringify(rows), iso(now)],
    );
  }
}

// ---- review items ----------------------------------------------------------

/**
 * Brings the open review list of one rule in line with what this run found.
 * Only differences are written: new items are added, items whose reason
 * changed are updated, and items that no longer apply are closed.
 */
export async function saveReviewItems(db, { ruleId, items, now }) {
  const { rows } = await db.query(
    'SELECT hubspot_id, status, match_key, detail FROM review_items WHERE rule_id = $1 AND resolved_at IS NULL',
    [ruleId],
  );
  const open = new Map(rows.map((row) => [row.hubspot_id, row]));
  const current = new Set();
  const changed = [];
  for (const item of items) {
    current.add(item.id);
    const before = open.get(item.id);
    const key = item.key || '';
    const detail = item.detail || '';
    if (!before || before.status !== item.status || before.match_key !== key || before.detail !== detail) {
      changed.push({ id: item.id, status: item.status, key, detail });
    }
  }
  const resolved = [...open.keys()].filter((id) => !current.has(id));

  for (const group of chunk(changed, BULK * 2)) {
    await db.query(
      `INSERT INTO review_items (rule_id, hubspot_id, status, match_key, detail, first_seen_at, updated_at)
       SELECT $1, x.id, x.status, x.key, x.detail, $3::timestamptz, $3::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS x(id text, status text, key text, detail text)
       ON CONFLICT (rule_id, hubspot_id) DO UPDATE SET
         status = EXCLUDED.status,
         match_key = EXCLUDED.match_key,
         detail = EXCLUDED.detail,
         first_seen_at = CASE WHEN review_items.resolved_at IS NULL THEN review_items.first_seen_at ELSE EXCLUDED.first_seen_at END,
         updated_at = EXCLUDED.updated_at,
         resolved_at = NULL`,
      [ruleId, JSON.stringify(group), iso(now)],
    );
  }
  for (const group of chunk(resolved, BULK * 5)) {
    await db.query(
      `UPDATE review_items SET resolved_at = $3::timestamptz, updated_at = $3::timestamptz
       WHERE rule_id = $1 AND resolved_at IS NULL AND hubspot_id = ANY(${ID_ARRAY(2)})`,
      [ruleId, idList(group), iso(now)],
    );
  }
  return { added: changed.length, resolved: resolved.length };
}

export async function openReviewCounts(db) {
  const { rows } = await db.query(
    'SELECT rule_id, status, count(*)::int AS n FROM review_items WHERE resolved_at IS NULL GROUP BY rule_id, status ORDER BY rule_id, status',
  );
  return rows.map((row) => ({ ruleId: row.rule_id, status: row.status, count: row.n }));
}

export async function openReviewItems(db, ruleId) {
  const { rows } = await db.query(
    `SELECT hubspot_id, status, match_key, detail, first_seen_at FROM review_items
     WHERE rule_id = $1 AND resolved_at IS NULL ORDER BY length(hubspot_id), hubspot_id`,
    [ruleId],
  );
  return rows.map((row) => ({ id: row.hubspot_id, status: row.status, key: row.match_key, detail: row.detail, firstSeenAt: row.first_seen_at }));
}

const reviewItemRow = (row) => ({ id: row.hubspot_id, status: row.status, key: row.match_key, detail: row.detail, firstSeenAt: iso(row.first_seen_at) });

/**
 * Open review items of one rule and one reason, newest first (admin page).
 * limit null returns them all, up to max.
 */
export async function reviewItemsList(db, { ruleId, status, limit = null, offset = 0, max = 100_000 }) {
  const { rows } = await db.query(
    `SELECT hubspot_id, status, match_key, detail, first_seen_at FROM review_items
     WHERE rule_id = $1 AND status = $2 AND resolved_at IS NULL
     ORDER BY first_seen_at DESC, length(hubspot_id), hubspot_id LIMIT $3 OFFSET $4`,
    [ruleId, status, limit ?? max, offset],
  );
  return rows.map(reviewItemRow);
}

/** When the review lists were last brought up to date: when the latest live run that saved its findings finished. */
export async function reviewListsAsOf(db) {
  const { rows } = await db.query(
    `SELECT started_at, finished_at FROM runs
     WHERE state_saved AND NOT dry_run AND mode IN ('incremental', 'full') AND finished_at IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`,
  );
  return rows.length ? iso(rows[0].finished_at) : null;
}

// ---- deal amount baselines (Item B3) ---------------------------------------

/** { headerId: { amount, recheck } } for the given headers, or for every header when ids is null. */
export async function loadBaselines(db, ids = null) {
  const out = {};
  if (ids === null) {
    const { rows } = await db.query('SELECT header_id, amount, recheck FROM deal_amount_baselines');
    for (const row of rows) out[row.header_id] = { amount: row.amount, recheck: row.recheck };
    return out;
  }
  for (const group of chunk([...ids].map(String), BULK * 5)) {
    const { rows } = await db.query(
      `SELECT header_id, amount, recheck FROM deal_amount_baselines WHERE header_id = ANY(${ID_ARRAY(1)})`,
      [idList(group)],
    );
    for (const row of rows) out[row.header_id] = { amount: row.amount, recheck: row.recheck };
  }
  return out;
}

/**
 * Quote headers whose deal amount may need a look: no amount recorded yet,
 * flagged for another look, amount different from the recorded one, or listed
 * in includeIds. With all = true every header is returned (catch-up run).
 */
export async function headerAmountCandidates(db, { objectKey, amountProperty, includeIds = [], all = false }) {
  const { rows } = await db.query(
    `SELECT r.hubspot_id AS id, r.properties, b.amount AS baseline, b.recheck, b.recheck_until, b.new_lines_until, (b.header_id IS NOT NULL) AS known
     FROM staging_records r
     LEFT JOIN deal_amount_baselines b ON b.header_id = r.hubspot_id
     WHERE r.object_key = $1 AND r.hubspot_id IS NOT NULL AND r.missing_since IS NULL
       AND ($4::boolean OR b.header_id IS NULL OR b.recheck IS NOT NULL OR b.new_lines_until IS NOT NULL
            OR COALESCE(btrim(r.properties->>$2), '') <> b.amount
            OR r.hubspot_id = ANY(${ID_ARRAY(3)}))
     ORDER BY length(r.hubspot_id), r.hubspot_id`,
    [objectKey, amountProperty, idList(includeIds), all],
  );
  return rows;
}

/** Headers flagged for another look, and headers that gained a line and whose amount may still be catching up. */
export async function headersToRecheck(db, now) {
  const { rows } = await db.query(
    'SELECT header_id FROM deal_amount_baselines WHERE recheck IS NOT NULL OR new_lines_until > $1::timestamptz',
    [iso(now)],
  );
  return rows.map((row) => row.header_id);
}

/**
 * Flags headers for another look on the next run, as soon as their lines were
 * linked, so the flag survives a run that stops before it reaches the deal
 * amounts. A header with no recorded amount gets its current staging amount.
 */
export async function flagHeaders(db, { objectKey, amountProperty, ids, recheck, until = null, now }) {
  for (const group of chunk([...ids].map(String), BULK * 5)) {
    // A record_only flag that is still within its settle time is not replaced by a plain "check".
    await db.query(
      `INSERT INTO deal_amount_baselines AS b (header_id, amount, recheck, recheck_until, updated_at)
       SELECT r.hubspot_id, COALESCE(btrim(r.properties->>$2), ''), $4, $6::timestamptz, $5::timestamptz
       FROM staging_records r
       WHERE r.object_key = $1 AND r.hubspot_id = ANY(${ID_ARRAY(3)})
       ON CONFLICT (header_id) DO UPDATE SET recheck = EXCLUDED.recheck, recheck_until = EXCLUDED.recheck_until, updated_at = EXCLUDED.updated_at
         WHERE NOT (b.recheck = 'record_only' AND b.recheck_until > $5::timestamptz AND EXCLUDED.recheck <> 'record_only')`,
      [objectKey, amountProperty, idList(group), recheck, iso(now), until ? iso(until) : null],
    );
  }
}

/**
 * Marks headers that gained a line in this run (linked by the run, or created
 * since the previous run) as soon as that is known, so the mark survives a
 * run that stops before it reaches the deal amounts. Only headers that
 * already have a recorded amount are marked here; the others get the mark
 * when their amount is first recorded.
 */
export async function markNewLines(db, { ids, until }) {
  for (const group of chunk([...ids].map(String), BULK * 5)) {
    await db.query(
      `UPDATE deal_amount_baselines SET new_lines_until = GREATEST(new_lines_until, $2::timestamptz)
       WHERE header_id = ANY(${ID_ARRAY(1)})`,
      [idList(group), iso(until)],
    );
  }
}

/**
 * entries: [{ id, amount, recheck, until, newLinesUntil }] where recheck is
 * null, "check" or "record_only" (kept until `until`), and newLinesUntil is
 * how long an amount change still counts as caused by a new line (or null).
 */
export async function saveBaselines(db, { entries, now }) {
  for (const group of chunk(entries, BULK * 5)) {
    await db.query(
      `INSERT INTO deal_amount_baselines (header_id, amount, recheck, recheck_until, new_lines_until, updated_at)
       SELECT x.id, COALESCE(x.amount, ''), x.recheck, x.until, x."newLinesUntil", $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, amount text, recheck text, until timestamptz, "newLinesUntil" timestamptz)
       ON CONFLICT (header_id) DO UPDATE SET amount = EXCLUDED.amount, recheck = EXCLUDED.recheck, recheck_until = EXCLUDED.recheck_until, new_lines_until = EXCLUDED.new_lines_until, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(group), iso(now)],
    );
  }
}

// ---- deal amount changes held by the guard (Item B3) ------------------------

/** Changes still held for review, oldest first. */
export async function openDealAmountHolds(db) {
  const { rows } = await db.query(
    `SELECT id, deal_id, header_id, amount_before, amount_after, reasons, first_held_at, last_seen_at, released_at, released_amount
     FROM deal_amount_holds WHERE resolved_at IS NULL ORDER BY first_held_at, id`,
  );
  return rows.map(holdRow);
}

function holdRow(row) {
  return {
    id: String(row.id),
    dealId: row.deal_id,
    headerId: row.header_id,
    from: row.amount_before,
    to: row.amount_after,
    reasons: row.reasons,
    firstHeldAt: iso(row.first_held_at),
    lastSeenAt: iso(row.last_seen_at),
    // Set when the change was released on the admin page; the release is for releasedAmount only.
    releasedAt: row.released_at ? iso(row.released_at) : null,
    releasedAmount: row.released_at ? row.released_amount : null,
  };
}

/**
 * Releases held changes (admin page). items: [{ id, amount }], where amount is
 * the quote amount the person saw. A hold is only released while it is still
 * open, not released yet, and still for that amount. Returns the holds released.
 */
export async function releaseDealAmountHolds(db, { items, now }) {
  if (items.length === 0) return [];
  const { rows } = await db.query(
    `UPDATE deal_amount_holds h SET released_at = $2::timestamptz, released_amount = h.amount_after
     FROM jsonb_to_recordset($1::jsonb) AS x(id text, amount text)
     WHERE h.id = x.id::bigint AND h.resolved_at IS NULL AND h.released_at IS NULL AND h.amount_after = x.amount
     RETURNING h.id, h.deal_id, h.header_id, h.amount_before, h.amount_after, h.reasons, h.first_held_at, h.last_seen_at, h.released_at, h.released_amount`,
    [JSON.stringify(items.map((item) => ({ id: String(item.id), amount: String(item.amount ?? '') }))), iso(now)],
  );
  return rows.map(holdRow);
}

const HOLD_COLUMNS = 'h.id, h.deal_id, h.header_id, h.amount_before, h.amount_after, h.reasons, h.first_held_at, h.last_seen_at, h.released_at, h.released_amount';

/** { open, released }: changes held now, and how many of them are released and waiting for a run. */
export async function dealAmountHoldCounts(db) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS open, count(released_at)::int AS released FROM deal_amount_holds WHERE resolved_at IS NULL',
  );
  return { open: rows[0].open, released: rows[0].released };
}

/**
 * Changes held now, oldest first, each with the quote number of its quote
 * header from the staging copy (admin page). ids: only these holds.
 * waiting: only holds that are not released yet. limit null returns them all, up to max.
 */
export async function dealAmountHoldsList(db, { headerKey = null, quoteNumberProperty = null, ids = null, waiting = false, limit = null, offset = 0, max = 100_000 } = {}) {
  const { rows } = await db.query(
    `SELECT ${HOLD_COLUMNS}, s.properties ->> $2 AS quote_number
     FROM deal_amount_holds h
     LEFT JOIN staging_records s ON s.object_key = $1 AND s.hubspot_id = h.header_id
     WHERE h.resolved_at IS NULL
       AND ($3::jsonb IS NULL OR h.id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb))))
       AND (NOT $4::boolean OR h.released_at IS NULL)
     ORDER BY h.first_held_at, h.id LIMIT $5 OFFSET $6`,
    [headerKey, quoteNumberProperty, ids ? idList(ids) : null, waiting, limit ?? max, offset],
  );
  return rows.map((row) => ({ ...holdRow(row), quoteNumber: row.quote_number ?? '' }));
}

/** The changes released on the admin page that a run has applied, latest first: what became of a release. */
export async function appliedDealAmountReleases(db, { headerKey = null, quoteNumberProperty = null, limit = 20 } = {}) {
  const { rows } = await db.query(
    `SELECT ${HOLD_COLUMNS}, h.resolved_at, s.properties ->> $2 AS quote_number
     FROM deal_amount_holds h
     LEFT JOIN staging_records s ON s.object_key = $1 AND s.hubspot_id = h.header_id
     WHERE h.resolution = 'applied' AND h.released_at IS NOT NULL
     ORDER BY h.resolved_at DESC, h.id DESC LIMIT $3`,
    [headerKey, quoteNumberProperty, limit],
  );
  return rows.map((row) => ({ ...holdRow(row), quoteNumber: row.quote_number ?? '', appliedAt: iso(row.resolved_at) }));
}

/** Takes a release back, as long as no run has applied it. Returns the hold, or null when there was nothing to take back. */
export async function cancelDealAmountRelease(db, id) {
  const { rows } = await db.query(
    `UPDATE deal_amount_holds SET released_at = NULL, released_amount = NULL
     WHERE id = $1::bigint AND resolved_at IS NULL AND released_at IS NOT NULL
     RETURNING id, deal_id, header_id, amount_before, amount_after, reasons, first_held_at, last_seen_at, released_at, released_amount`,
    [String(id)],
  );
  return rows.length ? holdRow(rows[0]) : null;
}

/** A release that no longer matches the quote amount lapses: the change is held again. */
export async function lapseDealAmountReleases(db, ids) {
  for (const group of chunk([...ids], BULK)) {
    await db.query(
      `UPDATE deal_amount_holds SET released_at = NULL, released_amount = NULL
       WHERE resolved_at IS NULL AND id::text = ANY(${ID_ARRAY(1)})`,
      [idList(group)],
    );
  }
}

/**
 * held: [{ dealId, headerId, from, to, reasons }] changes held in this run; a
 * change that was already held keeps its first_held_at.
 * resolved: [{ id, resolution }] holds that ended in this run.
 */
export async function saveDealAmountHolds(db, { held = [], resolved = [], runId, now }) {
  for (const group of chunk(held, BULK)) {
    await db.query(
      `INSERT INTO deal_amount_holds (deal_id, header_id, amount_before, amount_after, reasons, first_held_at, first_run_id, last_seen_at, last_run_id)
       SELECT x."dealId", x."headerId", COALESCE(x."from", ''), COALESCE(x."to", ''), x.reasons, $3::timestamptz, $2, $3::timestamptz, $2
       FROM jsonb_to_recordset($1::jsonb) AS x("dealId" text, "headerId" text, "from" text, "to" text, reasons jsonb)
       ON CONFLICT (deal_id, header_id) WHERE resolved_at IS NULL DO UPDATE SET
         amount_before = EXCLUDED.amount_before,
         amount_after = EXCLUDED.amount_after,
         reasons = EXCLUDED.reasons,
         last_seen_at = EXCLUDED.last_seen_at,
         last_run_id = EXCLUDED.last_run_id`,
      [JSON.stringify(group), runId, iso(now)],
    );
  }
  for (const group of chunk(resolved, BULK)) {
    await db.query(
      `UPDATE deal_amount_holds h SET resolved_at = $3::timestamptz, resolution = x.resolution, resolved_run_id = $2
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, resolution text)
       WHERE h.id = x.id::bigint AND h.resolved_at IS NULL`,
      [JSON.stringify(group), runId, iso(now)],
    );
  }
}

// ---- run lock --------------------------------------------------------------

/** Takes the single run lock. Returns false when another holder has it and it is not stale. */
export async function acquireRunLock(db, { holder, now, staleAfterMs }) {
  const staleBefore = new Date(new Date(now).getTime() - staleAfterMs).toISOString();
  const { rows } = await db.query(
    `INSERT INTO run_lock (id, holder, taken_at) VALUES (1, $1, $2::timestamptz)
     ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, taken_at = EXCLUDED.taken_at
       WHERE run_lock.taken_at < $3::timestamptz
     RETURNING holder`,
    [holder, iso(now), staleBefore],
  );
  return rows.length === 1;
}

/** Heartbeat: a running holder keeps its lock fresh so only a dead process's lock goes stale. */
export async function touchRunLock(db, holder, now) {
  await db.query('UPDATE run_lock SET taken_at = $2::timestamptz WHERE id = 1 AND holder = $1', [holder, iso(now)]);
}

export async function releaseRunLock(db, holder) {
  await db.query('DELETE FROM run_lock WHERE id = 1 AND holder = $1', [holder]);
}

// ---- alert settings and state ----------------------------------------------

/** Creates the settings row from the service variables the first time only; later edits in the admin page win. */
export async function ensureAlertSettings(db, { emailRecipients = [], repeatMinutes = 60, now }) {
  await db.query(
    `INSERT INTO alert_settings (id, enabled, email_recipients, repeat_minutes, updated_at)
     VALUES (1, true, $1::jsonb, $2, $3::timestamptz) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(emailRecipients), repeatMinutes, iso(now)],
  );
  await db.query('INSERT INTO alert_state (id, failing) VALUES (1, false) ON CONFLICT (id) DO NOTHING');
}

export async function getAlertSettings(db) {
  const { rows } = await db.query('SELECT enabled, email_recipients, repeat_minutes, updated_at FROM alert_settings WHERE id = 1');
  const row = rows[0];
  if (!row) return { enabled: true, emailRecipients: [], repeatMinutes: 60, updatedAt: null };
  return { enabled: row.enabled, emailRecipients: row.email_recipients, repeatMinutes: row.repeat_minutes, updatedAt: row.updated_at };
}

export async function saveAlertSettings(db, { enabled, emailRecipients, repeatMinutes, now }) {
  await db.query(
    `INSERT INTO alert_settings (id, enabled, email_recipients, repeat_minutes, updated_at)
     VALUES (1, $1, $2::jsonb, $3, $4::timestamptz)
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, email_recipients = EXCLUDED.email_recipients,
       repeat_minutes = EXCLUDED.repeat_minutes, updated_at = EXCLUDED.updated_at`,
    [Boolean(enabled), JSON.stringify(emailRecipients), repeatMinutes, iso(now)],
  );
}

export async function getAlertState(db) {
  const { rows } = await db.query('SELECT failing, last_alert_at, last_sent_at, last_subject, last_result FROM alert_state WHERE id = 1');
  const row = rows[0];
  if (!row) return { failing: false, lastAlertAt: null, lastSentAt: null, lastSubject: null, lastResult: null };
  return { failing: row.failing, lastAlertAt: row.last_alert_at, lastSentAt: row.last_sent_at, lastSubject: row.last_subject, lastResult: row.last_result };
}

/** lastSentAt, lastSubject and lastResult are only overwritten when given. */
export async function saveAlertState(db, { failing, lastAlertAt, lastSentAt = null, lastSubject = null, lastResult = null }) {
  await db.query(
    `INSERT INTO alert_state (id, failing, last_alert_at, last_sent_at, last_subject, last_result)
     VALUES (1, $1, $2::timestamptz, $3::timestamptz, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET failing = EXCLUDED.failing, last_alert_at = EXCLUDED.last_alert_at,
       last_sent_at = COALESCE(EXCLUDED.last_sent_at, alert_state.last_sent_at),
       last_subject = COALESCE(EXCLUDED.last_subject, alert_state.last_subject),
       last_result = COALESCE(EXCLUDED.last_result, alert_state.last_result)`,
    [Boolean(failing), iso(lastAlertAt), iso(lastSentAt), lastSubject, lastResult === null ? null : JSON.stringify(lastResult)],
  );
}

// ---- run schedule ----------------------------------------------------------

/** The schedule saved on the admin page, or null while the RUN_INTERVAL_MINUTES variable applies. */
export async function getScheduleSettings(db) {
  const { rows } = await db.query('SELECT enabled, interval_minutes, updated_at FROM schedule_settings WHERE id = 1');
  const row = rows[0];
  return row ? { enabled: row.enabled, intervalMinutes: Number(row.interval_minutes), updatedAt: row.updated_at } : null;
}

export async function saveScheduleSettings(db, { enabled, intervalMinutes, now }) {
  await db.query(
    `INSERT INTO schedule_settings (id, enabled, interval_minutes, updated_at)
     VALUES (1, $1, $2, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, interval_minutes = EXCLUDED.interval_minutes,
       updated_at = EXCLUDED.updated_at`,
    [Boolean(enabled), intervalMinutes, iso(now)],
  );
}

// ---- admin page password ---------------------------------------------------

/** The password set on the admin page, as hashes, or null while the ADMIN_PASSWORD variable is the password. */
export async function getAdminPassword(db) {
  const { rows } = await db.query('SELECT password_hash, variable_hash, changed_at FROM admin_password WHERE id = 1');
  const row = rows[0];
  return row ? { passwordHash: row.password_hash, variableHash: row.variable_hash, changedAt: row.changed_at } : null;
}

export async function saveAdminPassword(db, { passwordHash, variableHash, now }) {
  await db.query(
    `INSERT INTO admin_password (id, password_hash, variable_hash, changed_at)
     VALUES (1, $1, $2, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, variable_hash = EXCLUDED.variable_hash,
       changed_at = EXCLUDED.changed_at`,
    [passwordHash, variableHash, iso(now)],
  );
}

/** Removes the stored password that was set under the given variable hash, and no newer one. */
export async function clearAdminPassword(db, { variableHash }) {
  const { rowCount } = await db.query('DELETE FROM admin_password WHERE id = 1 AND variable_hash = $1', [variableHash]);
  return rowCount > 0;
}

// ---- contact cleanup backup (Item B2) --------------------------------------

/** rows: [{ headerId, headerKey, fromType, toType, toId, types, result }] */
export async function insertRemovals(db, { runId, rows, now }) {
  for (const group of chunk(rows, BULK * 2)) {
    const payload = group.map((r) => ({
      header_id: r.headerId,
      header_key: r.headerKey || '',
      from_type: r.fromType,
      to_type: r.toType,
      to_id: r.toId,
      types: r.types || [],
      result: r.result,
    }));
    await db.query(
      `INSERT INTO contact_cleanup_removals (run_id, header_id, header_key, from_object_type, to_object_type, to_id, types, result, created_at)
       SELECT $1, x.header_id, x.header_key, x.from_type, x.to_type, x.to_id, x.types, x.result, $3::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS x(header_id text, header_key text, from_type text, to_type text, to_id text, types jsonb, result text)`,
      [runId, JSON.stringify(payload), iso(now)],
    );
  }
}

export async function setRemovalResults(db, { runId, toType, pairs, result }) {
  for (const group of chunk(pairs, BULK * 2)) {
    await db.query(
      `UPDATE contact_cleanup_removals r SET result = $4
       FROM jsonb_to_recordset($2::jsonb) AS x(header_id text, to_id text)
       WHERE r.run_id = $1 AND r.to_object_type = $3 AND r.header_id = x.header_id AND r.to_id = x.to_id`,
      [runId, JSON.stringify(group.map((p) => ({ header_id: p.fromId, to_id: p.toId }))), toType, result],
    );
  }
}

export async function removalsForRun(db, runId) {
  const { rows } = await db.query(
    `SELECT header_id, header_key, from_object_type, to_object_type, to_id, types, result, restored_at
     FROM contact_cleanup_removals WHERE run_id = $1 ORDER BY id`,
    [runId],
  );
  return rows.map((row) => ({
    headerId: row.header_id,
    headerKey: row.header_key,
    fromType: row.from_object_type,
    toType: row.to_object_type,
    toId: row.to_id,
    types: row.types,
    result: row.result,
    restoredAt: row.restored_at,
  }));
}

export async function markRemovalsRestored(db, { runId, pairs, toType, now }) {
  for (const group of chunk(pairs, BULK * 2)) {
    await db.query(
      `UPDATE contact_cleanup_removals r SET restored_at = $4::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS x(header_id text, to_id text)
       WHERE r.run_id = $1 AND r.to_object_type = $3 AND r.header_id = x.header_id AND r.to_id = x.to_id`,
      [runId, JSON.stringify(group.map((p) => ({ header_id: p.fromId, to_id: p.toId }))), toType, iso(now)],
    );
  }
}
