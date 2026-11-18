# Industrious association cleanup middleware (Option B v3)

A Node.js service that fills in missing associations between Epicor-sourced records in HubSpot, on a schedule, and lets deal amounts follow their quotes when a quote gains lines. It implements Items B1, B2 and B3 of "Industrious - Epicor HubSpot Association Cleanup - Option B v3", with the decisions Zach made on 2026-11-12 (staging database, quote number matching, Resend, admin page) and 2026-11-13 (second deal by quote number; deal amounts change only on open deals, only when the quote gained a new line, and only when the change is not out of proportion).

**It works only in HubSpot.** Jitterbit keeps upserting Epicor data into HubSpot exactly as it does today; this service reads what has landed in HubSpot and fixes the links there. It has no Epicor connection, no Jitterbit connection, and no setting for either. The outside systems it talks to are the HubSpot API, its own Postgres database and, for failure alerts, Resend (email) and a Slack webhook.

**It is a dry run until told otherwise.** Every command only reads from HubSpot and reports what it would do, unless `--apply` is given or `DRY_RUN=false` is set.

## How it works

Each run has three steps.

1. **Ingest.** The records of every object the rules use are copied from HubSpot into the staging database (Postgres): everything the first time and once every `FULL_REFRESH_HOURS` (24 by default), otherwise the records created or modified since the previous run.
2. **Match and associate.** For each rule below, in this order, the staging database matches records on the Epicor IDs they already carry. For every match that is not associated in HubSpot, the association is created. Existing associations are never changed or removed, so running twice changes nothing the second time.
3. **Deal amounts (Item B3).** When a quote has gained a new line and its amount has changed since the service last recorded it, the amount on the quote's deal is set to the quote amount. Amount is the only deal field written. Closed deals (won or lost) are never changed. A quote amount that changed without a new line is left alone. A change that would set the deal to 0, move it by more than 1,000,000, or change it by more than 50% of what the deal carries now is held for review instead of being applied.

| Order | Item | Association | Matched on | Type ID |
| --- | --- | --- | --- | --- |
| 1 | B1 | Quote line -> quote header | line `quote_number` = quote `quote_number` | 98 |
| 2 | B1 | Task -> quote header | task `quote_id` = quote `quote_number` | 123 |
| 3 | B1 | Quote header -> deal | quote `hubspot_deal_id` = deal record ID | 99 |
| 4 | B1 | Quote header -> deal, by quote number | quote `quote_number` = deal `quote_num` (typed by hand on the deal) | 99 |
| 5 | B1 | Quote header -> company | quote `customer_uid` = company `customer_uid` | 95 |
| 6 | B1 | IC code -> company | IC code `customer_uid` = company `epicor_customer_id` | 93 |
| 7 | B2 | Quote header -> Epicor Contact | customer number + quote contact number (off until the two properties exist) | 148 |

Rules 1 to 3, 5 and 6 use the same keys and association types as the portal's existing association workflows, read from the portal on 2026-11-12.

Every run matches all records in staging, not only the new ones. A line that arrived before its quote is linked on the first run after the quote arrives; a deal that gets its quote number typed in later is linked on the next run.

### Records held for review

One kind of match is not clear-cut. The service does not associate it; it lists it for a person to decide.

- **A quote number typed on more than one deal.** The quote is not linked to any of them (rule 4, `onMultipleTargets: "skip"`), whether or not it already has a deal.

The count is in the "Held for review" section of every report, the record IDs are in the report's unresolved CSV, and after a live run they are in the `review_items` table and listed on the admin page under Review, each with a link that opens the record in HubSpot. When the duplicate quote number is cleared on one deal in HubSpot, the next run links the quote and drops it from the list.

### Records that are already associated to something else

The service only ever adds. When a record already has a different parent than the one its ID points to, the matching one is added next to it and the existing association is kept (`ifAssociatedElsewhere: "add"` on every rule). Each report says how many records this applied to. Two cases matter in this portal:

- **A quote that already has a deal, and whose quote number is typed on a different deal,** gets that second deal as well (rule 4). A quote with more than one deal is outside Item B3: see "Item B3 and the quote amount".
- **A quote on a different company than its customer ID points to** gets the matching company as well (rule 5).

Setting `ifAssociatedElsewhere: "skip"` on a rule holds such records for review instead.

## The staging database

Postgres, on Railway next to the service. It replaces the state file of the earlier build. Tables are created by the SQL files in `migrations/`.

| Table | Holds |
| --- | --- |
| `staging_records` | A copy of each record the rules use: object, HubSpot ID, the mapped properties (including the Epicor IDs), when it was last copied |
| `staging_associations` | The associations as last read from HubSpot |
| `ingest_cursors` | Per object: where the next ingest starts, and when everything was last copied |
| `runs` | One row per run: mode, dry run or live, status, counts, the report text |
| `association_actions` | Every association a run created (or, in a dry run, would create) |
| `review_items` | Records that could not be associated and why (no match, blank ID, held for review) |
| `deal_amount_baselines` | Item B3: the last quote amount recorded per quote, and until when a quote that gained a line still counts as having new lines |
| `deal_amount_holds` | Item B3: deal amount changes held for review by the guard, with the deal, the quote and the amount before and after, and whether the change was released on the admin page |
| `contact_cleanup_removals` | Item B2 cleanup: every association removed, for restore |
| `alert_settings`, `alert_state` | Alert switch, recipients, repeat interval; whether runs are currently failing |
| `admin_password` | The admin page password once it has been changed on the page, as salted hashes only. Empty while `ADMIN_PASSWORD` is the password |
| `schedule_settings` | The schedule once it has been saved on the admin page: on or paused, and how often. Empty while `RUN_INTERVAL_MINUTES` is the schedule |
| `run_lock` | Stops two live runs from writing at the same time |

HubSpot stays the authority. Before creating anything the service re-reads the associations of the records involved from HubSpot, and every `FULL_REFRESH_HOURS` it re-reads everything. If the database is lost, the next run rebuilds the staging copy from HubSpot; see the runbook for what else is affected.

**Option C.** The staging tables are laid out so a later Option C can feed the same database: `staging_records` has a `source` column (always `hubspot` today), a `source_record_id`, and allows a row without a HubSpot ID. Matching reads only the object name and the properties, so rows written straight from Epicor would be matched the same way. Nothing in this build writes such rows.

## Requirements

- Node.js 22.
- A Postgres database (Railway's Postgres service; tested on Postgres 16, and the migrations also applied cleanly on Railway's Postgres 18).
- A HubSpot private app token for the Industrious portal, with scopes `crm.objects.custom.read`, `crm.objects.custom.write`, `crm.schemas.custom.read`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.companies.read`, `crm.objects.companies.write`. For the standard Contact part of the one-time contact cleanup, also `crm.objects.contacts.read` and `crm.objects.contacts.write`.
- For email alerts: a Resend API key and a from address on a domain verified in Resend. For Slack alerts: an incoming webhook URL.
- A password for the admin page.

Settings are environment variables; `.env.example` lists all of them. Secrets (`HUBSPOT_PRIVATE_APP_TOKEN`, `DATABASE_URL`, `ADMIN_PASSWORD`, `RESEND_API_KEY`, `ALERT_SLACK_WEBHOOK_URL`) are read from the environment only and are never written to a log, a report, the database or the admin page.

## Running it locally

```bash
npm install
npm test                                   # embedded Postgres, no server needed

docker compose up -d                       # local Postgres (or use any Postgres you have)
cp .env.example .env                       # fill in the token and DATABASE_URL

node --env-file=.env src/cli.js preflight  # read-only: checks config/mapping.json against the portal
node --env-file=.env src/cli.js reconcile  # dry run of the full pass; writes a report, changes nothing in HubSpot
node --env-file=.env src/cli.js start      # the service: admin page on http://localhost:3000, scheduled runs (dry run)
```

Without a Postgres server, `DATABASE_URL=pglite:./data/staging` uses an embedded database. It is a development dependency and is not installed on Railway.

The admin page's sign-in cookie is marked secure. If a browser does not keep you signed in over plain `http://localhost`, set `ADMIN_INSECURE_COOKIE=true` locally (never on Railway).

To run the tests against a real Postgres server through the same driver the service uses: `TEST_DATABASE_URL=postgres://user:pass@host:5432/db npm test`.

## Deploying to Railway

The repository is `patch-ops-llc/industrious-data-patcher` on GitHub and the Railway project is `industrious-data-patcher` in the PatchOps workspace. The middleware service there is connected to the repository's `main` branch, so a push to `main` deploys. The steps below are how the project was set up, and how to set it up again.

1. Create the repository and push this folder as its root (`package-lock.json` included; `.gitignore` keeps `node_modules`, `.env`, `reports/` and `data/` out).
2. In a new Railway project add a **PostgreSQL** database service (New, Database, PostgreSQL). Keep its default name, `Postgres`.
3. Add a service from the repository and enter its settings on the service in Railway: start command `node src/cli.js start`, pre-deploy command `node src/cli.js migrate`, health check on `/healthz` with a 120-second timeout, restart on failure (10 retries), draining time 120 seconds, one replica. Railway does not read these from the repository: it has deprecated `railway.json` (Config as Code) and ignores it on new services, so the repository has none. The runbook lists the settings under "Railway setup".
4. Set the service variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference to the database service; the private network needs no SSL) |
| `HUBSPOT_PRIVATE_APP_TOKEN` | The private app token |
| `ADMIN_PASSWORD` | The starting password for the admin page (12 characters or more). It can be changed on the page afterwards; giving this variable a new value resets it. See "The admin page" |
| `DRY_RUN` | Leave unset (dry run) until go-live, then `false` |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | For email alerts. `ALERT_EMAIL_TO` is only the starting list; recipients are edited on the admin page afterwards |
| `ALERT_SLACK_WEBHOOK_URL` | Optional, for Slack alerts |
| `RUN_INTERVAL_MINUTES` | Optional; 30 by default. The starting schedule only: once the schedule is saved on the admin page, the page's value applies |

5. Generate a public domain for the service (Settings, Networking). The admin page is served there over HTTPS. Railway sets `PORT` itself.
6. Deploy. The pre-deploy step creates the tables; the service then starts in dry run, makes its first run straight away, and repeats every 30 minutes.

Run exactly one replica. A second copy would be held off by the run lock, but there is nothing to gain from it.

### Go-live order

1. `preflight`, then `reconcile` as a dry run. Review the report (see "Reports").
2. `reconcile --limit <n> --apply` for a small live sample, and check those records in HubSpot.
3. `reconcile --apply` for the full reconciliation. Its report holds the association counts before and after. Linking lines that were sitting unassociated changes the amount of their quotes, and the deals of those quotes are then updated: in the same run where HubSpot has already recalculated the quote amount, otherwise in the next live run (see "Item B3 and the quote amount"). The dry run of step 1 lists these deal changes in advance. Closed deals are left alone, and changes that would set a deal to 0, move it by more than 1,000,000 or change it by more than 50% are held, not applied. The `-deal-amounts.csv` of each run lists every deal changed, every change held and every closed deal left alone, with the amount before and after.
4. Set `DRY_RUN=false` on the service so its runs write (the scheduled ones and "Sync now" on the admin page).
5. After validation, turn off the HubSpot association workflows. That is a manual step in HubSpot; this service does not change workflows, and it does not conflict with them while they are on.

Commands are run in a shell on the service (Railway CLI: `railway ssh`, then `node src/cli.js <command>`), so they use the service's variables and database.

## Commands and what each one changes

| Command | Reads from HubSpot | Changes in HubSpot (only with `--apply` or `DRY_RUN=false`) | Writes elsewhere |
| --- | --- | --- | --- |
| `start` | As `run`, on the schedule (`RUN_INTERVAL_MINUTES`, or the schedule saved on the admin page) and when "Sync now" is pressed there | As `run` | Staging database. Serves the admin page and `/healthz` |
| `run` | Records created or modified since the last run (everything on the first run and every `FULL_REFRESH_HOURS`) | Creates missing associations. Sets `amount` on open deals whose quote gained a new line and changed amount, except changes held by the guard | Staging database, report files |
| `reconcile` | Every record of every object, and every association | Creates missing associations. Deal amounts as `run` | Staging database, `reconciliation-*` report files |
| `reconcile --deal-amounts` | Same | Also sets every deal amount that differs from its quote amount, for that one run, whether or not the quote gained a line (the catch-up; off unless asked for, see Item B3). Closed deals are still left alone and the guard applies here too | Same |
| `cleanup-contacts` | Every quote and its contact associations | Item B2 one-time cleanup: removes contact associations from quotes, keeping the contact named on the quote | Backup of every removal (database and file), summary |
| `cleanup-contacts --restore <run id or file>` | The backup | Puts the removed associations back | Summary |
| `migrate` | Nothing | Nothing, ever | Creates or updates the staging tables |
| `report [run id]` | Nothing | Nothing, ever | Prints the stored report of the last run, or of the given run |
| `preflight` | Object schemas, properties, association types | Nothing, ever | Nothing |
| `discover` | Same, as a listing | Nothing, ever | `discover-*.json` |

Nothing in HubSpot is ever deleted except associations in `cleanup-contacts`. No record is created, merged or deleted. No property other than deal `amount` is written. No workflow, property definition or setting is changed.

Options: `--apply` writes; `--dry-run` forces a dry run; `--limit <n>` changes at most n records per association and n deals (n quotes for `cleanup-contacts`), for a first small live sample; `--output <dir>` moves the report files.

### What a dry run does

A dry run sends nothing to HubSpot except read requests. It does write to the staging database: the copy of the records, the associations it read, a `runs` row with its report, and the associations it would create (marked `planned`). It does not touch the review list, the recorded quote amounts, the list of held deal amount changes or the record of which lines have already counted as newly arrived, so a dry run never changes what a later live run will do.

A dry run also projects the deal amounts. For every quote that would have lines linked, it adds up the amounts of the quote's lines (the ones it has now plus the ones that would be linked), which is what HubSpot's rollup will show once they are linked, and reports what Item B3 would then do: which deals would be updated, with the amount before and after and the change as a percentage, which changes the guard would hold, and which closed deals would be left alone. Lines the run links count as new lines. This uses read requests only. Switch it off with `dealAmount.projection.enabled: false`.

### Reports

Each `run` and `reconcile` writes to `REPORTS_DIR` (default `./reports`): a Markdown report, the full JSON, a CSV of records that could not be associated, a CSV of every association created (or planned), and a CSV of every deal amount change with the value before and after, including the changes held by the guard (`result` starts with `held:`) and the changes left alone because the deal is closed (`skipped: deal is closed`). A dry run that would link lines also writes `-projected-deal-amounts.csv`: one row per deal whose amount would change once the lines are linked, with the change as a percentage of the deal's current amount, marked `would_update`, `held: <reason>` or `skipped: deal is closed`. Every report, dry or live, has a "Deal amount changes held for review" section; the one-line run summary in the log and in alerts gives the number held. The Markdown report is also stored in the database; `node src/cli.js report` prints the latest. Files written inside the Railway container disappear on the next deploy, so copy out the ones to keep.

## Configuration: `config/mapping.json`

All object types, property names, match keys and association type IDs live in this file, so adding an object or a mapping later is a configuration change. It is filled in for the Industrious portal. Two values are placeholders because the properties do not exist yet (see Item B2). `preflight` checks the file against the portal.

- `portalId`: the HubSpot portal (account) ID, `44686929`. Only used to build the links to records on the admin page (`https://app.hubspot.com/contacts/<portalId>/record/<object type>/<record ID>`). Without it the Review lists show record IDs as plain text.
- `rules[].enabled`: switch a rule on or off.
- `rules[].onMultipleTargets`: `skip` (default; a record whose key matches more than one parent is held for review) or `associate_all`.
- `rules[].ifAssociatedElsewhere`: `add` (default, and what every shipped rule uses; the matching record is added next to a different one already associated, nothing is removed) or `skip` (held for review).
- `rules[].ifNoMatch`: `report` (default) or `ignore_if_associated`. Rule 4 uses the second: a quote whose number is on no deal is only reported as unmatched when it has no deal at all.
- `keyNormalization.treatAsBlank`: filler values that mean "no ID" (`0` on tasks without a quote).
- `dealAmount`: `enabled`, `skipClosedDeals` (`true`: the amount of a closed deal is never changed), `requireNewLines` (`true`: a deal amount only changes when its quote gained a new line) with `newLinesWindowMinutes` (`120`), `requireOneToOne` (`true`: a deal is only updated when the quote has exactly one deal and the deal exactly one quote), `backfillInFullRun` (`false`: the catch-up of existing mismatches is off), `backlogLinkedLines` (`update_deals`) and `backlogSettleMinutes` (see Item B3).
- `dealAmount.guard`: `holdZeroAmount` (`true`: a change that would set a deal amount to 0 is held), `holdLargeChange` (`true`) with `largeChangeThreshold` (`1000000`: a change that moves a deal amount by more than this, up or down, is held), `holdPercentChange` (`true`) with `percentChangeThreshold` (`50`: a change of more than this percentage of the deal's current amount, up or down, is held), and `releaseDealIds` (deal record IDs the guard lets through). See "The guard on deal amount changes".
- `dealAmount.projection`: `enabled` (`true`) and `lineAmount` (the name, under `objects.quoteLine.properties`, of the line amount). Dry runs only; see "What a dry run does".
- `contactCleanup`: `requireNamedContactFound`, `removeOnlyTypeIds`, and the `standardContacts` block (see Item B2).

Editing mappings in a web page is a later phase in the spec and is not built.

## The admin page

`start` serves a small page on the service's public address:

- see link health: how many records of each type are linked to the record their ID matches,
- see the status and counts of the last run,
- review the records that are held or unmatched, with links to them in HubSpot, and release held deal amount changes ("Review"),
- start a run now ("Sync now"),
- pause the schedule or change how often it runs,
- turn alerts on and off, set the email recipients and the repeat interval,
- send a test alert,
- change the page's own password.

These settings are stored in the staging database, so they survive restarts and deploys.

**Link health.** The first box on the page answers "how much is linked", not only "what is missing". One line per kind of record:

| Line | Linked means | Matched on |
| --- | --- | --- |
| Epicor Quote Line Item to Epicor Quote | the line is associated with the quote that has its quote number | `quote_number` |
| Epicor Task to Epicor Quote | the task is associated with the quote that has its quote number | `quote_id` |
| Epicor Quote to Deal | the quote is associated with the deal its deal ID names, or with the deal that carries its quote number | `hubspot_deal_id` or `quote_number` |
| Epicor Quote to Company | the quote is associated with the company that has its customer ID | `customer_uid` |
| Customer IC Code to Company | the IC code is associated with the company that has its customer ID | `customer_uid` |

Each line shows the number of records, how many of them carry an ID, how many are linked, and that share as a percentage and a bar. What is not linked is listed next to it with the reason: would be linked by a live run (after a dry run), failed, held for review, the ID matches no record, or the record has no ID. Linked, pending, failed, held and no match add up to the records with an ID.

- The percentage is the share of records with an ID. A record without one (a task with quote ID 0, for example) cannot be matched and is counted separately, not against the percentage. It is rounded down, so 100% means every one.
- "Linked" means linked by ID. A quote someone associated by hand with a deal that neither its deal ID nor its quote number leads to is counted under "match no Deal", and its association is left alone.
- The two ways of finding a quote's deal are one line: a quote counts as linked when either found it linked, and once.
- The figures are those of the last finished run, which the box names. Every run works them out from what it already reads, for every record and not only the changed ones, with no extra call to HubSpot. They are stored with the run (`runs.summary`, key `health`) and logged as `link health` lines. A run in progress or a failed run leaves the previous figures in place. After a deploy the box fills in when the first run has finished.

**Review.** The second section of the page, linked from the header, from the chips in Link health and from Last run. It answers "which records are these": everything on it is read from the staging database, as the last live run left it, with no call to HubSpot.

- **Associations.** One block per pair of record types, as in Link health, and one row per way of matching (the two ways of finding a quote's deal are two rows). Each row counts the records that are held for review (the ID matches more than one record), have no match, have no ID, or failed. A count opens the list: the record, the ID it carries, the reason (for a held quote: the deals its number is typed on, and the deal it already has), and since when it has been on the list. Lists are 100 to a page, newest first, and each has a CSV download with every record and its link.
- **Record links.** Every record ID opens that record in HubSpot in a new tab. The links are built from `portalId` in the mapping and the object type; the page sends no referrer to HubSpot. The pages show what is on a record as text only.
- **Deal amount changes held.** The changes the guard holds (see "The guard on deal amount changes"): deal, quote and quote number, the amount the deal carries now, the quote amount that was not applied, the difference, why it is held and since when. Also as a CSV.
- **Releasing a held change.** Tick the changes, choose "Release selected" (or "Release all"), and confirm on the next page, which lists exactly what will be released. The release is written to the staging database (`deal_amount_holds.released_at`, `released_amount`) and to the service log; the page itself does not touch HubSpot. The next live run, scheduled or started with "Sync now", sets each released deal to that amount and takes it off the list; the report of that run says "applied: released on the admin page", and the page lists it under "Released and applied". In a dry-run service the release waits for the first live run.
- **A release is for one amount.** It lets through the change to the quote amount that was shown, for that deal and that quote, and nothing else. If the quote amount is different when the run looks at it, the release is dropped and the change is held again with the new amount (the report says so). A release is refused when the list was out of date (the amount is no longer the one held). It can be cancelled on the list until a run has applied it; while a run is in progress cancelling is refused, because that run may already be applying it.
- A dry run fills none of these lists: `review_items` and `deal_amount_holds` are written by live runs only. A record matched in more than one way can be on more than one list, so the lists can add up to more than the figures in Link health, which count each record once.

**Sync now.** The button starts the run the schedule would make next: the incremental `run`, in the mode the service is in. While `DRY_RUN` is not `false` that is a dry run, which reads from HubSpot and changes nothing; after go-live it writes, exactly as a scheduled run does. The page cannot choose the mode, a limit or a full reconciliation, and anything extra sent with the form is ignored. One run at a time: while a run is in progress the button is replaced by "Follow this run", and a request to start another is refused. After pressing it the page reloads every 5 seconds until the run has finished and then shows the result under Last run. The run counts as a run of the service: alerts follow its result, and the next scheduled run comes one interval after it started.

**The schedule.** One tick box and one list:

- "Run on a schedule" switches the scheduled runs on or off. Paused, the service runs only when "Sync now" is pressed, and it does not run at start either; the run in progress when it is paused finishes.
- "How often" is a fixed list: every 15 or 30 minutes, every hour, every 2, 4, 6 or 12 hours, once a day, plus the value of `RUN_INTERVAL_MINUTES` if that is not one of them. Nothing else is accepted: no free-form interval, no times of day, no cron expression.
- The interval is counted from the start of one run to the start of the next, and runs never overlap. A change takes effect at once, without a restart: the next run comes one interval after the last one started, or straight away if that moment has passed.
- Until the schedule is saved on the page, `RUN_INTERVAL_MINUTES` is the schedule and it is on. Once it has been saved, the page's value applies and the variable is ignored (table `schedule_settings`). The service log says at start which of the two is in use (`schedule`, `scheduleFrom`).

What the page does not do, by design: it cannot switch dry run on or off, cannot run a full reconciliation or the contact cleanup, cannot edit mappings or the guard's thresholds, cannot resolve a held association (that is done in HubSpot), and never shows the HubSpot token, the Resend key, the Slack webhook, the database address or the password. Those are service variables and commands, and the only secret a form on the page accepts is the page's own password. The admin code does not load the HubSpot client or the run engine at all: "Sync now" and the schedule only pass a request to the service's scheduler, which runs what it would have run anyway, and a release is a row in the staging database that the next run reads. Releasing a held deal amount change is the one thing on the page that decides what a run writes to HubSpot.

Sign-in is one shared password, not individual accounts. Ten wrong passwords within 15 minutes, at sign-in or as the current password on the change form, lock both for everyone until they age out. Sessions last `ADMIN_SESSION_HOURS` (12) and end when the service restarts.

**The password.**

- It starts as the `ADMIN_PASSWORD` service variable (12 characters or more). Without that variable the page is switched off and answers 503; the service and the health check keep running.
- It can be changed on the page: current password, new password (12 characters or more), and the new one again. The staging database then holds a salted scrypt hash of the new password (table `admin_password`) and never the password itself. Every other session is signed out.
- Once it has been changed on the page, the value of `ADMIN_PASSWORD` no longer signs in. Keep the variable set all the same: removing it switches the page off.
- **Recovery, if the password is forgotten:** give `ADMIN_PASSWORD` a new value in Railway, different from the one it has. The service restarts, sees that the variable is no longer the value it was when the password was changed, removes the stored password, and the variable's new value is the password again. Setting the variable to the value it already has changes nothing.
- Recovery needs access to the Railway project, which already holds every other secret of the service, so it opens no new way in. The service log says at start which of the two is in use (`adminSignIn`), and logs a warning when a reset happens. No password or hash is ever logged or shown.

**The look.** The pages carry the Industrious Group branding from industriousgroup.com: the logo, the orange and charcoal, heavy headings in capitals. The site's typeface, Proxima Nova, is licensed through Adobe Fonts and cannot be redistributed, so the pages use Montserrat (SIL Open Font License), the closest open typeface. The logo, the icons and the font are in `src/admin/assets/` and are served by the service; the pages load nothing from another site, use no JavaScript, and set strict browser security headers (the content security policy allows styles, images and fonts from the service itself and nothing else).

## Alerts

An alert goes out on the first run that fails or finishes with errors, at most once per repeat interval while runs keep failing, and once more when a run succeeds again. Email goes through Resend (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`); Slack through `ALERT_SLACK_WEBHOOK_URL`. Either, both or neither can be set up.

`ALERT_EMAIL_TO` and `ALERT_MIN_REPEAT_MINUTES` only fill in the settings the first time the database is created. After that the admin page is the place to change them.

## Item B2 (contacts) is built but switched off

The spec has the middleware associate contacts to quote headers on the quote contact number, after Jitterbit starts sending two fields. Neither exists in the portal today: there is no quote contact number on Epicor Quote and no contact number on Epicor Contact. Until Jitterbit writes them:

- the `contacts_to_header` rule is disabled, and
- `cleanup-contacts` refuses to run.

To switch it on: put the two property names in `config/mapping.json` (the `REPLACE_ME` values), set the rule's `enabled` to `true`, run `preflight`, then dry-run `cleanup-contacts`. The match is customer number plus contact number, on the reading that contact numbers are unique within a customer.

### The one-time cleanup

`cleanup-contacts` removes the Epicor Contact associations the retired workflow left on quotes and keeps the one contact named by the quote contact number. A quote with no quote contact number, or whose named contact is missing or ambiguous in HubSpot, is left untouched and counted.

**Standard Contacts are a separate switch, off by default.** With `contactCleanup.standardContacts.enabled: true` the same command also removes standard HubSpot Contact associations from those quotes. It keeps the standard Contact(s) associated to the quote's named Epicor Contact. A quote whose named Epicor Contact has no standard Contact is left alone, because nothing says which standard Contact to keep. (`keepLinkedToNamedContact: false` removes them all instead.)

Every removal, of either kind, is recorded before it is made: in the `contact_cleanup_removals` table and in a backup file. `cleanup-contacts --restore <run id> --apply` (or `--restore <file>`) puts them back with their original association types and labels.

## Item B3 and the quote amount

The quote `amount` in this portal is a HubSpot rollup of the associated line amounts. It changes when Jitterbit changes a line, and also when a line is newly associated to its quote, including by this service. The service records the last amount it saw per quote. When a later run sees a different amount on a quote that gained a new line, it updates the deal. A quote seen for the first time only has its amount recorded.

These rules follow Zach's instruction of 2026-11-13: do not change closed deals, and do not change any amount unless there are new lines and the amount is not wildly different.

- **Closed deals are never changed** (`skipClosedDeals: true`). A deal that HubSpot marks as closed, won or lost, keeps its amount whatever happens to its quote. The report counts these under "Skipped" (`deal_closed`) and the `-deal-amounts.csv` lists each one with the amount it would have been set to. The change is not carried over: a deal that is reopened later follows its quote from the next change on. Associations are still added to quotes whose deal is closed. `skipClosedDeals: false` updates closed deals like open ones.
- **Only when the quote gained a new line** (`requireNewLines: true`). A new line is a line this service linked to the quote in that run, or a line that arrived in HubSpot since the previous live run (first read from HubSpot after that run started), whether the service or HubSpot's own workflow linked it. A quote amount that changes with no new line, for example a price change on an existing line, is recorded and the deal left alone; the report gives the number of such quotes. HubSpot recalculates a quote's amount some time after a line is linked, so an amount change counts as caused by the new line when it shows up within `newLinesWindowMinutes` (120) of the quote gaining it; within that time the quote is read again on every run. On a new staging database nothing counts as newly arrived until the first live run has finished, so lines that reached HubSpot and were linked by HubSpot's workflow before the service went live do not move their deals. `requireNewLines: false` lets every quote amount change reach the deal.
- **Only one quote with one deal.** A deal is updated only when the quote has exactly one deal and that deal has exactly one quote (`requireOneToOne: true`). A quote with two deals, or a deal shared by two quotes, is skipped: neither deal is changed, the report counts it under "Skipped" (`header_has_multiple_deals`, `deal_has_multiple_headers`), and the change is not carried over to later runs. This includes every quote that the quote number rule gives a second deal.
- **Quote and deal pairs whose amounts already differ are not touched** (993 pairs when the portal was read on 2026-11-12). A deal only changes when its quote gains a line and changes amount after the service first recorded it. Linking a quote to a deal does not by itself set the deal amount.
- **The catch-up is a separate setting, off by default.** `dealAmount.backfillInFullRun: true` makes every `reconcile` set every deal amount that differs from its quote amount, new line or not; `reconcile --deal-amounts` does the same for one run. Closed deals are still left alone and the guard still applies. Scheduled runs never catch up. Dry-run it first: it also covers the deals newly linked by quote number, whose amounts were never in step with their quotes.
- **Linking lines that were sitting unassociated updates the deal** (`backlogLinkedLines: "update_deals"`). Lines the service links count as new lines, also when they have been in HubSpot for months. When the service links such lines the quote's rollup changes, and the deal is set to the new amount, subject to the rules above and the guard below. HubSpot recalculates the rollup some time after the lines are linked, so the deal follows in the same run or the next one. The new quote amount does not exist in HubSpot until the lines are linked, so a dry run works it out from the line amounts and lists the deal changes as a projection (see "What a dry run does"). The alternative, `backlogLinkedLines: "record_only"`, records the new amount without changing the deal when the lines are linked by `reconcile` or by the very first live run (for `backlogSettleMinutes`, 120, after linking).

### The guard on deal amount changes

Three kinds of deal amount change are held for review instead of being applied:

- a change that would set the deal amount to 0 (`dealAmount.guard.holdZeroAmount`, on);
- a change that moves the deal amount by more than 1,000,000, up or down (`holdLargeChange`, on, with `largeChangeThreshold`). A change of exactly 1,000,000 goes through. A blank deal amount counts as 0;
- a change of more than 50% of the amount the deal carries now, up or down (`holdPercentChange`, on, with `percentChangeThreshold`). From 1,000, anything above 1,500 or below 500 is held; exactly 50% goes through. A deal that carries 0 or no amount has no percentage to measure against, so any change to it is held.

The guard covers every deal amount change the service makes: amounts that change after lines arrive or are linked, and the catch-up. A change can be held for more than one reason; the report names each.

A held change is not applied and not dropped. It is stored in `deal_amount_holds` with the deal, the quote, the deal amount now and the quote amount that was not applied, the reason, and when it was first held. On every later run, scheduled or `reconcile`, the service reads that quote and deal again and lists the change in the report under "Deal amount changes held for review", with the date it was first held. It stays there until one of these happens, and the report of that run says which:

- **It is released on the admin page.** Under Review, "Deal amount changes held": choose the change, confirm, and the next live run sets that deal to the quote amount that was shown. The release is for that amount only; see "The admin page". No deploy is needed.
- **It is released in the mapping.** Change the mapping and deploy: set `holdZeroAmount`, `holdLargeChange` or `holdPercentChange` to `false`, raise `largeChangeThreshold` or `percentChangeThreshold`, or add single deals to `releaseDealIds` (the deal record IDs from the report). A deal listed there passes all three holds. The next run sets those deals to their quote amount as it is then; a held change does not need another new line to be applied. Run `reconcile` as a dry run first: its report lists what the release would apply.
- **It no longer applies.** The deal and the quote agree again (someone corrected the deal by hand, or the quote amount changed back), the quote was requoted to an amount the guard does not catch (the deal is then updated as usual), or Item B3 no longer acts on the pair (the deal was closed, the quote has no deal or more than one, the deal has more than one quote, the quote was deleted).

A dry run lists the changes it would hold without recording them.

## What is not in this build

- **Anything in Epicor or Jitterbit.** Item B4 and the Jitterbit mapping changes for the two Item B2 fields are being handled outside this service.
- **Workflow changes.** Turning off the existing HubSpot association workflows is a manual step after validation.
- **The repository and the Railway project** are not part of the build, but both now exist: repository `patch-ops-llc/industrious-data-patcher`, Railway project `industrious-data-patcher` in the PatchOps workspace. See "Deploying to Railway".
- **Mapping editing in the admin page.** A later phase in the spec.

## Tested and not tested

Tested: the automated suite (`npm test`) against an in-memory stand-in for the HubSpot API, on the embedded Postgres and on a Postgres 16 server through the `pg` driver. It covers the shipped mapping against a stand-in laid out like the Industrious portal, the command line end to end in its own process (including the service, the health check, the admin page and alerts through local stand-ins for Resend and Slack), migrations, the admin page's sign-in and form protections, changing and recovering the admin password, link health (per kind of record, in dry and live runs, with the two deal rules counted once), and "Sync now" and the schedule (through the real service in dry run, and the scheduler with pausing, interval changes and runs by hand). A copy of the portal's records and associations (read on 2026-11-12) was loaded into the stand-in and the service run against that copy. The suite also covers the Review pages (the lists, paging, record links, CSV downloads, text shown as text, no call to HubSpot) and releasing a held deal amount change (confirmation, form protections, applied by the next live run for the approved amount only, dropped when the quote amount moves, cancelling). The admin page, including link health, the password change, "Sync now" and the schedule, was checked in Chrome at desktop and phone widths against a local dry run with the stand-in HubSpot; the Review pages and a release, from ticking the change to the run that applied it, were checked the same way against a local live run with the stand-in. Read-only against the real portal: `preflight` passes, and a full `reconcile` dry run was made on 2026-11-13.

Not tested: any write to the real portal; a live `reconcile` against the real portal; the amounts HubSpot's rollup really shows after lines are linked (the projection assumes the quote amount is the sum of its line amounts, which held for every quote with lines when the portal was read); a live run on Railway (the build and the migrations have run there, the migrations against Railway's Postgres 18); delivery through the real Resend API or a real Slack webhook; `docker-compose.yml`.
