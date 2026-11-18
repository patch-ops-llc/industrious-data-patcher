-- The schedule of the service's runs, once it has been changed on the admin page.
--
-- No row: the schedule is on and the interval is the RUN_INTERVAL_MINUTES
-- service variable.
-- A row: the schedule is what the row says, and RUN_INTERVAL_MINUTES no longer
-- applies. Deleting the row puts the variable back in charge.

CREATE TABLE schedule_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          BOOLEAN          NOT NULL,
  interval_minutes DOUBLE PRECISION NOT NULL CHECK (interval_minutes >= 1),
  updated_at       TIMESTAMPTZ      NOT NULL
);

COMMENT ON TABLE schedule_settings IS 'The run schedule set on the admin page: whether scheduled runs are on, and the minutes from the start of one run to the start of the next. Empty until the schedule is first saved on the page; until then RUN_INTERVAL_MINUTES applies.';
COMMENT ON COLUMN schedule_settings.enabled IS 'False while scheduled runs are paused. Runs can still be started by hand from the admin page.';
