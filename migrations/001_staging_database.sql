-- Staging database for the association cleanup middleware (Option B v3).
--
-- Layout: the staging_* tables hold a copy of the records and associations
-- the middleware works on, keyed so that matching on the Epicor IDs is done
-- here and not in HubSpot. Everything else is run state.
--
-- Option C: today every staging row is ingested from HubSpot
-- (source = 'hubspot', hubspot_id filled in). A later Option C can insert
-- rows straight from Epicor into the same tables with source = 'epicor',
-- source_record_id set and hubspot_id empty until the record exists in
-- HubSpot. The matching queries read object_key and properties, so the same
-- matching works on rows from either source; Option B only acts on rows that
-- have a hubspot_id.

CREATE TABLE staging_records (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_key          TEXT        NOT NULL,
  hubspot_object_type TEXT,
  hubspot_id          TEXT,
  source              TEXT        NOT NULL DEFAULT 'hubspot',
  source_record_id    TEXT,
  properties          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  hs_created_at       TIMESTAMPTZ,
  hs_modified_at      TIMESTAMPTZ,
  first_ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ingest_run     TEXT,
  missing_since       TIMESTAMPTZ,
  CONSTRAINT staging_records_hubspot_key UNIQUE (object_key, hubspot_id)
);

COMMENT ON TABLE staging_records IS 'One row per record the middleware works on. object_key is the name used in config/mapping.json (quoteHeader, quoteLine, ...). properties holds the mapped HubSpot properties, including the Epicor IDs used for matching.';
COMMENT ON COLUMN staging_records.missing_since IS 'Set when a full ingest no longer finds the record in HubSpot (deleted or merged). Such rows are ignored by matching.';
COMMENT ON COLUMN staging_records.source IS 'Where the row was ingested from. Always hubspot in Option B.';

CREATE INDEX staging_records_object_idx ON staging_records (object_key) WHERE missing_since IS NULL;

CREATE TABLE staging_associations (
  from_object_type TEXT        NOT NULL,
  from_id          TEXT        NOT NULL,
  to_object_type   TEXT        NOT NULL,
  to_id            TEXT        NOT NULL,
  types            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  read_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (from_object_type, to_object_type, from_id, to_id)
);

COMMENT ON TABLE staging_associations IS 'Associations as last read from HubSpot, by HubSpot object type and record ID. A missing association is an expected pair (from matching) that has no row here.';

CREATE TABLE ingest_cursors (
  object_key     TEXT PRIMARY KEY,
  changes_since  TIMESTAMPTZ,
  full_ingest_at TIMESTAMPTZ
);

COMMENT ON TABLE ingest_cursors IS 'Per object: the start time of the last completed ingest (the next ingest asks HubSpot for records created or modified since then) and when the object was last ingested in full.';

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  mode            TEXT        NOT NULL,
  dry_run         BOOLEAN     NOT NULL,
  limit_n         INTEGER,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL,
  error           TEXT,
  state_saved     BOOLEAN     NOT NULL DEFAULT false,
  summary         JSONB,
  report_markdown TEXT
);

CREATE INDEX runs_started_idx ON runs (started_at DESC);

CREATE TABLE association_actions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  rule_id          TEXT        NOT NULL,
  from_object_type TEXT        NOT NULL,
  from_id          TEXT        NOT NULL,
  to_object_type   TEXT        NOT NULL,
  to_id            TEXT        NOT NULL,
  result           TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE association_actions IS 'Every association a run created (result = created) or, in a dry run, would have created (result = planned).';

CREATE INDEX association_actions_run_idx ON association_actions (run_id);

CREATE TABLE review_items (
  rule_id       TEXT        NOT NULL,
  hubspot_id    TEXT        NOT NULL,
  status        TEXT        NOT NULL,
  match_key     TEXT        NOT NULL DEFAULT '',
  detail        TEXT        NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ,
  PRIMARY KEY (rule_id, hubspot_id)
);

COMMENT ON TABLE review_items IS 'Records a rule could not associate, with the reason: no_target (no record with that Epicor ID yet), missing_key, multiple_targets (held for review), associated_elsewhere (held for review), failed. Open items have resolved_at empty; an item is closed when the reason no longer applies. Written by live runs only.';

CREATE INDEX review_items_open_idx ON review_items (rule_id, status) WHERE resolved_at IS NULL;

CREATE TABLE deal_amount_baselines (
  header_id  TEXT PRIMARY KEY,
  amount     TEXT        NOT NULL DEFAULT '',
  recheck    TEXT,
  recheck_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE deal_amount_baselines IS 'Item B3. The quote header amount last seen per header; a later, different amount is a change. recheck = check: look again next run; recheck = record_only: the amount is recorded without updating the deal, on every run until recheck_until has passed (lines linked from the backlog; the header amount is a rollup that HubSpot recalculates some time after the lines are linked).';

CREATE TABLE contact_cleanup_removals (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  header_id        TEXT        NOT NULL,
  header_key       TEXT        NOT NULL DEFAULT '',
  from_object_type TEXT        NOT NULL,
  to_object_type   TEXT        NOT NULL,
  to_id            TEXT        NOT NULL,
  types            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  result           TEXT        NOT NULL,
  restored_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE contact_cleanup_removals IS 'Item B2 one-time cleanup: the backup of every association removed (result = removed; pending until the removal is confirmed; failed when HubSpot still has it) or, in a dry run, that would be removed (result = planned), with the association types it had, so it can be restored.';

CREATE INDEX contact_cleanup_removals_run_idx ON contact_cleanup_removals (run_id);

CREATE TABLE alert_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          BOOLEAN     NOT NULL DEFAULT true,
  email_recipients JSONB       NOT NULL DEFAULT '[]'::jsonb,
  repeat_minutes   INTEGER     NOT NULL DEFAULT 60,
  updated_at       TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE alert_settings IS 'Alert settings edited in the admin page. No secrets: the Resend API key, sender address and Slack webhook stay in service variables.';

CREATE TABLE alert_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  failing         BOOLEAN     NOT NULL DEFAULT false,
  last_alert_at   TIMESTAMPTZ,
  last_sent_at    TIMESTAMPTZ,
  last_subject    TEXT,
  last_result     JSONB
);

COMMENT ON TABLE alert_state IS 'failing and last_alert_at drive the repeat interval for failure alerts. last_sent_at, last_subject and last_result describe the last message sent (failure, recovery or test), for the admin page.';

CREATE TABLE run_lock (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  holder   TEXT        NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL
);
