-- Item B3 guard: releasing a held deal amount change on the admin page.
--
-- released_at empty: the change is held, as before.
-- released_at set: someone released it on the admin page. released_amount is
-- the quote amount they saw and approved. The next live run sets the deal to
-- that amount and closes the hold as applied. If the quote amount is no longer
-- the approved one by then, the release lapses: both columns are emptied and
-- the change is held again with its new amount.

ALTER TABLE deal_amount_holds ADD COLUMN released_at TIMESTAMPTZ;
ALTER TABLE deal_amount_holds ADD COLUMN released_amount TEXT;

COMMENT ON COLUMN deal_amount_holds.released_at IS 'When the held change was released on the admin page. Empty while it is held. Kept after the change is applied.';
COMMENT ON COLUMN deal_amount_holds.released_amount IS 'The quote amount that was approved when the change was released. The release only applies to this amount.';
