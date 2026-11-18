# Runbook: Industrious association cleanup middleware

For whoever operates the service after go-live. It covers the schedule, where to look, how alerting works, what to do when something goes wrong, and how to ask for another object or mapping.

The service works only in HubSpot. It does not connect to Epicor or Jitterbit. If records are missing from HubSpot altogether (for example quotes with no line records), that is a Jitterbit load problem and this service cannot fix it; it will link the records when they arrive.

## Schedule

- The service makes one run every `RUN_INTERVAL_MINUTES` (default 30) until the schedule is saved on the admin page. From then on the page's schedule applies and the variable is ignored.
- **Changing it:** sign in to the admin page and use the Schedule box. Choose how often from the list (every 15 or 30 minutes, every hour, every 2, 4, 6 or 12 hours, once a day) and press "Save schedule". It takes effect straight away, with no redeploy, and is kept across restarts and deploys. The interval is counted from the start of one run to the start of the next. There are no times of day and no cron expressions.
- **Pausing it:** untick "Run on a schedule" and save. The run in progress, if any, finishes; no other run starts by itself, also not after a restart or deploy, until the box is ticked again. The page and the log line `service starting` (`schedule: paused`) say so. A paused service notices nothing in HubSpot, so do not leave it paused by accident.
- **Running one now:** "Sync now" on the admin page starts the same run the schedule makes, at once, in the service's mode: a dry run while `DRY_RUN` is not `false`, live after go-live. The page follows the run and shows its result under Last run when it finishes. It works while the schedule is paused. The next scheduled run comes one interval after it started.
- Runs never overlap. If a run takes longer than the interval, the next one starts when it finishes, and "Sync now" is refused while a run is in progress.
- A run copies the records created or modified in HubSpot since the previous run (minus a five-minute overlap) into the staging database, then matches every record in staging. A record that misses an association on one run is picked up on the next.
- Once every `FULL_REFRESH_HOURS` (default 24) a run copies everything again and re-reads every association from HubSpot. This is what notices records deleted or merged in HubSpot and associations removed by hand.

## Railway setup

| Setting | Value |
| --- | --- |
| Services | The middleware (from the repository) and a PostgreSQL database |
| Start command | `node src/cli.js start` |
| Pre-deploy command | `node src/cli.js migrate`; creates or updates the tables before each deploy |
| Health check path | `/healthz` |
| Health check timeout | 120 seconds |
| Restart policy | On failure, at most 10 retries |
| Draining time | 120 seconds |
| Overlap time | 0 seconds |
| Replicas | 1 |
| Variables | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `HUBSPOT_PRIVATE_APP_TOKEN`, `ADMIN_PASSWORD`, `DRY_RUN`, and the alert settings. See `.env.example` |
| Public domain | Needed for the admin page |

The start command, pre-deploy command, health check, restart policy, draining time and overlap time are settings on the middleware service in Railway, not files in the repository. Railway has deprecated `railway.json` (Config as Code) and ignores it on new services, so the repository has none. If the service is ever recreated, enter these values by hand in the service's settings before the first deploy; without them a deploy runs with no pre-deploy step and no health check.

`DRY_RUN` controls whether the service's runs write, scheduled or started with "Sync now". Leave it unset or `true` to watch what the service would do; set it to `false` to go live.

On a deploy the old copy is told to stop and is given two minutes to finish its current run. If a run is cut off, its lock is taken over after `RUN_LOCK_STALE_MINUTES` (15); until then live runs report `skipped`.

## Where to look

- **Admin page** (the service's public address): status and counts of the last run, "Sync now", the schedule, alert settings, test alert, and changing the page's password.
- **Service log:** JSON lines in Railway under the service. Each run logs `run started`, one `rule processed` line per association with its counts, `deal amounts processed`, and `run finished` with the status.
- **Last report:** `node src/cli.js report` in a shell on the service (`railway ssh`), or `report <run id>` for an earlier run.
- **Staging database** (Railway's data view, or any Postgres client):

```sql
-- the last 20 runs
SELECT started_at, mode, dry_run, status, error FROM runs ORDER BY started_at DESC LIMIT 20;

-- what is waiting for a person, by association and reason
SELECT rule_id, status, count(*) FROM review_items WHERE resolved_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2;

-- quotes held because their quote number is on more than one deal
SELECT hubspot_id, match_key, detail FROM review_items
WHERE rule_id = 'header_to_deal_by_quote_number' AND status = 'multiple_targets' AND resolved_at IS NULL;

-- quotes with more than one deal (Item B3 does not update either deal)
SELECT from_id AS quote_id, count(*) AS deals, string_agg(to_id, ', ') AS deal_ids
FROM staging_associations
WHERE from_object_type = '2-45361208' AND to_object_type = 'deals'
GROUP BY from_id HAVING count(*) > 1;

-- deal amount changes held for review by the guard (still open)
SELECT deal_id, header_id AS quote_id, amount_before AS deal_amount, amount_after AS quote_amount, reasons, first_held_at
FROM deal_amount_holds WHERE resolved_at IS NULL ORDER BY first_held_at;

-- quotes that gained a line recently: read again on every run, and an amount change still reaches the deal
SELECT header_id AS quote_id, amount AS recorded_quote_amount, new_lines_until
FROM deal_amount_baselines WHERE new_lines_until > now() ORDER BY new_lines_until;

-- held changes that came off the list, and how
SELECT deal_id, header_id AS quote_id, amount_before, amount_after, resolution, resolved_at
FROM deal_amount_holds WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC;

-- every association the service created in the last day
SELECT rule_id, from_id, to_id, created_at FROM association_actions
WHERE result = 'created' AND created_at > now() - interval '1 day';
```

Run status values:

| Status | Meaning |
| --- | --- |
| `ok` | Finished. Records without a match are not errors; they are matched again on every run. |
| `completed_with_errors` | Finished, but HubSpot rejected some writes. Those records are tried again next run. |
| `failed` | Could not finish (HubSpot or the database unreachable, token rejected, daily API limit). Nothing is lost; the next run covers the same ground. |
| `skipped` | Another live run was in progress. |

Why a record was not associated (`review_items.status`, and the unresolved CSV of a report):

| Reason | Meaning | What happens |
| --- | --- | --- |
| `no_target` | No record with that Epicor ID exists in HubSpot. For the quote number rule: the quote has no deal at all | Matched again every run; linked when the other record arrives |
| `missing_key` | The Epicor ID on the record is blank (or `0`) | Picked up when the record gets its ID |
| `multiple_targets` | The ID matches more than one record (for example a quote number typed on two deals) | Held for review. Fix the duplicate in HubSpot and the next run links it |
| `associated_elsewhere` | Already associated to a different record than its ID points to. Only appears for a rule set to `ifAssociatedElsewhere: "skip"`; no shipped rule is, they add the matching record next to the existing one | Held for review; nothing is changed |
| `failed` | HubSpot rejected the write | Tried again next run |

## Alerting

Alert settings live on the admin page: on or off, email recipients, repeat interval, and a test button. Email goes through Resend and needs `RESEND_API_KEY` and `ALERT_EMAIL_FROM` (an address on a domain verified in Resend) as service variables. Slack needs `ALERT_SLACK_WEBHOOK_URL`. The page shows which channels are ready.

- An alert is sent on the first run of the service, scheduled or started with "Sync now", that fails or finishes with errors.
- While runs keep failing, the alert repeats at most once per repeat interval.
- A "recovered" message is sent on the first good run after a failure.
- With alerts switched off, or no channel set up, failures appear only in the log and on the admin page.
- A command run by hand in a shell that fails sends its own alert and does not affect the service's failing or recovered state.

After changing a Resend or Slack variable, use "Send test alert" to confirm delivery. The result of each channel is shown on the page.

## Common situations

**A run failed with a 401.** The HubSpot token was revoked or replaced. Put the new token in `HUBSPOT_PRIVATE_APP_TOKEN` and redeploy.

**A run failed with a 429 "daily limit".** The portal's daily API allowance is used up. Runs resume by themselves after HubSpot's reset. A scheduled run with nothing new uses about a dozen requests; a full `reconcile` uses several hundred. The portal's allowance is 1,000,000 a day.

**A run failed because the database could not be reached.** The alert still goes out, using `ALERT_EMAIL_TO` from the service variables if the saved recipients cannot be read. Check the Postgres service in Railway. Nothing in HubSpot is affected.

**The review list keeps growing.** Records are arriving whose parent never arrives (for example lines for quotes that are not in HubSpot), or quote numbers are being typed on more than one deal. Use the queries above, or the unresolved CSV from a `reconcile` dry run.

**A deal amount did not follow its quote.** Check these in order; the run report's "Deal amounts (Item B3)" section has the count for each.

- The deal is closed. Closed deals, won or lost, are never changed (`dealAmount.skipClosedDeals`). The `-deal-amounts.csv` of that run lists it as `skipped: deal is closed` with the amount it would have been set to.
- The quote did not gain a new line. A deal only follows when the quote gained a line that the service linked or that arrived since the previous live run (`dealAmount.requireNewLines`). A price change on an existing line, or an amount edited in HubSpot, is recorded and left alone. The same goes for a quote whose new amount showed up more than `newLinesWindowMinutes` (120) after it gained the line; raise that setting if HubSpot's recalculation is seen to take longer.
- The change is held by the guard: see "The report lists deal amount changes held for review" below.
- The quote has more than one deal, or the deal more than one quote. Item B3 only updates a deal when the quote has exactly one deal and that deal exactly one quote. The run report lists the others under "Skipped" (`header_has_multiple_deals`, `deal_has_multiple_headers`); the query above lists the quotes with more than one deal. A quote gets a second deal when it already had one and its quote number is typed on another. To bring such a quote back under Item B3, remove the association that should not be there in HubSpot, and clear the value that points to it (the quote number typed on the deal, or the deal ID on the quote), otherwise the next run adds it again. The skipped change is not replayed: the deal follows the next time the quote gains a line and changes amount.

To bring one deal in line with its quote by hand, set the deal amount in HubSpot. To do it for every differing pair, see the catch-up (`reconcile --deal-amounts`) in the README; it leaves closed deals alone and holds what the guard catches.

**Deal amounts changed right after a reconcile.** Expected. Linking lines that were sitting unassociated changes the quote amount, and the deal follows. The `reconcile` dry run lists these changes in advance ("Projected deal amount changes once lines are linked" and `-projected-deal-amounts.csv`). The `-deal-amounts.csv` of the live run has every deal with its amount before and after. Closed deals are left alone, and a change to 0, of more than 1,000,000, or of more than 50% of the deal's amount is held instead.

**The report lists deal amount changes held for review.** The guard held them: the change would set the deal to 0, move it by more than 1,000,000, or change it by more than 50% of what the deal carries now (`dealAmount.guard` in `config/mapping.json`). A deal that carries 0 or no amount is always held, because no percentage can be worked out for it. The deals were not changed. Each held change is listed in every run report with the deal, the quote, the deal amount now, the quote amount that was not applied, the reason and the date it was first held; the alert and log summary of each run gives the count, and the query above lists them. For each one, decide:

- The quote amount is right: release it. Add the deal record ID to `dealAmount.guard.releaseDealIds`, or release a whole kind by setting `holdZeroAmount`, `holdLargeChange` or `holdPercentChange` to `false` or raising `largeChangeThreshold` or `percentChangeThreshold`. Deploy, run `reconcile` as a dry run to see what would be applied, and let the next live run apply it. A switch that is turned off stays off for later changes too; `releaseDealIds` releases only the deals listed, for as long as they are listed.
- The deal amount is right: leave it. The change stays on the list. It comes off by itself when the quote and the deal agree again, the deal is closed, or the quote amount changes to one the guard does not catch.

A held change that comes off the list is named in that run's report as applied or as no longer applying, and its row in `deal_amount_holds` is kept with `resolution` filled in.

**A run status of `skipped` that does not clear.** A previous run was killed while holding the lock. The lock is taken over automatically after `RUN_LOCK_STALE_MINUTES` (15). To clear it by hand: `DELETE FROM run_lock;`

**The service was off for a while.** Nothing to do. The next run picks up everything created or modified since the last one.

**The admin page says it is switched off (503).** `ADMIN_PASSWORD` is not set or is shorter than 12 characters. Set it and redeploy.

**Locked out of the admin page.** Ten wrong passwords within 15 minutes lock sign-in for everyone until the oldest of them is 15 minutes old. Wait, or redeploy to clear it.

**Changing the admin password.** Sign in, and use the Password box on the admin page: current password, new password (12 characters or more), and the new one again. Every other session is signed out. From then on the value of `ADMIN_PASSWORD` in Railway no longer signs in; leave the variable set, because the page is switched off without it. The Password box says whether the password in use is the starting one from the variable or one set on the page, and when.

**The admin password is forgotten.** Give `ADMIN_PASSWORD` a new value in Railway (12 characters or more, and different from the value it has now). Railway redeploys the service, the service removes the password that was set on the page, and the new value of the variable is the password. The log line `service starting` then shows `adminSignIn: ADMIN_PASSWORD variable`, with a warning line saying the stored password was removed. Sign in with the new value and, if wanted, change the password on the page again. Saving the variable with the value it already has does nothing. The same reset can be done in the database with `DELETE FROM admin_password;`, after which the variable's current value signs in.

**Running a full pass by hand.** "Sync now" on the admin page is the ordinary incremental run; a full pass is a command. Open a shell on the service (`railway ssh`) so the same variables and database are used, then `node src/cli.js reconcile` for a dry run or add `--apply`. A live manual run and the scheduled run cannot overlap; whichever starts second is skipped. Report files written in the container are lost on the next deploy; `node src/cli.js report` prints the stored report at any time.

**The staging database was lost or replaced.** Nothing in HubSpot is lost. Deploy (the pre-deploy step creates the tables) and the next run copies everything from HubSpot again. What does not come back: the run history, the review list (rebuilt by the next live run), alert settings (start again from `ALERT_EMAIL_TO`), the recorded quote amounts (every quote counts as seen for the first time, so an amount change made while the database was gone is not pushed to the deal), the record of which lines have arrived (no line counts as newly arrived until the first live run on the new database has finished), the list of held deal amount changes (the deals stay as they are; a held change is not listed again until that quote next changes amount, so export the query above before replacing the database), and the contact cleanup backup. Keep the cleanup's backup file somewhere safe for that reason, and turn on backups for the Postgres service in Railway.

**Undoing something.** Every association created is in `association_actions` and in the run's `-associations.csv`; every deal amount change is in the run's `-deal-amounts.csv` with the amount before and after (rows marked `held:` or `skipped:` were not applied). The contact cleanup has `cleanup-contacts --restore <run id> --apply`.

## The one-time contact cleanup (Item B2)

It can only run once the two Item B2 properties exist and are in `config/mapping.json`.

1. `node src/cli.js cleanup-contacts` (dry run). Read the summary: quotes scanned, associations to remove, quotes skipped and why.
2. `node src/cli.js cleanup-contacts --limit 20 --apply` for a sample of 20 quotes; check them in HubSpot.
3. `node src/cli.js cleanup-contacts --apply`. The output ends with the restore command for that run. Copy the backup file out of the container.

Standard HubSpot Contacts are only included when `contactCleanup.standardContacts.enabled` is `true` in the mapping file. It is off as shipped. With it on, the summary has a separate `standardContacts` section, and the token also needs the contacts read and write scopes.

## Requesting additional objects or mappings

Everything the service matches on is in `config/mapping.json`. To add an association:

1. Send the request with: the two objects, the property on each that holds the shared Epicor ID, and the association type to use.
2. The change is the property names under `objects` (for this example, `"customerId": "customer_id"` under `objects.quoteTask.properties`; a whole new entry if the object is new) and an entry under `rules`:

```json
{
  "id": "tasks_to_company",
  "item": "added",
  "label": "Tasks to company",
  "enabled": true,
  "from": "quoteTask",
  "to": "company",
  "match": [{ "from": "customerId", "to": "customerId" }],
  "association": { "category": "USER_DEFINED", "typeId": 121 }
}
```

The property name and type ID 121 here are only an illustration; use the real ones from the portal (`discover` lists them).

3. Run `preflight` to confirm the names and type ID exist, `reconcile` as a dry run to see the counts, then deploy. The first run after the deploy copies the new object into staging.

Rules run in the order they are listed. No code change and no database change is needed for a new object or association. Anything beyond matching on shared IDs (new logic, new fields to write) is a code change.
