-- Item B3 guard: deal amount changes that were not applied because they would
-- set the deal to 0 or move it by more than the threshold in the mapping.

CREATE TABLE deal_amount_holds (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deal_id         TEXT        NOT NULL,
  header_id       TEXT        NOT NULL,
  amount_before   TEXT        NOT NULL DEFAULT '',
  amount_after    TEXT        NOT NULL DEFAULT '',
  reasons         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  first_held_at   TIMESTAMPTZ NOT NULL,
  first_run_id    TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  last_run_id     TEXT,
  resolved_at     TIMESTAMPTZ,
  resolution      TEXT,
  resolved_run_id TEXT
);

CREATE UNIQUE INDEX deal_amount_holds_open_idx ON deal_amount_holds (deal_id, header_id) WHERE resolved_at IS NULL;

COMMENT ON TABLE deal_amount_holds IS 'Item B3. Deal amount changes held for review by the guard (dealAmount.guard in the mapping). amount_before is the deal amount, amount_after the quote header amount it would be set to. A row with resolved_at empty is still held and is looked at again on every run. resolution = applied: the guard no longer held it and the deal was updated; resolution = no_longer_applies: the deal and quote agree again, or Item B3 no longer acts on the pair.';
