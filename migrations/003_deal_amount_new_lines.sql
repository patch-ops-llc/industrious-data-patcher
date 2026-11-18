-- Item B3: a deal amount only follows its quote when the quote gained a new
-- line (dealAmount.requireNewLines).

-- new_lines_until marks a quote that gained a line; an amount change seen
-- before that time counts as caused by the new line.
ALTER TABLE deal_amount_baselines ADD COLUMN new_lines_until TIMESTAMPTZ;

COMMENT ON COLUMN deal_amount_baselines.new_lines_until IS 'Set when a run links a line to the quote, or finds a line that arrived since the previous run on it. While this time is ahead the quote is read again on every run, and an amount change counts as caused by the new line. Cleared once the change has been looked at.';

-- arrivals_since is the start of the last run that recorded its results and
-- reached the deal amounts. Records first copied into staging after it have
-- "arrived since the last run". Dry runs and failed runs do not move it.
ALTER TABLE ingest_cursors ADD COLUMN arrivals_since TIMESTAMPTZ;

COMMENT ON COLUMN ingest_cursors.arrivals_since IS 'Start of the last recording run that reached the deal amounts (set for the quote line object). Lines first ingested after this time count as newly arrived for Item B3. Null until the first such run.';
