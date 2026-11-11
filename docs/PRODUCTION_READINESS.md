# Production Readiness

Stage A, 2 November 2026.

## Verdict

**Status on 11 November 2026, after the full roadmap (B4.4, B4.5, B5, C, D, E, F):**

**Demo-ready: yes.** All workflows run and are tested on SQLite; the UI is complete.
**Pilot-ready (self-hosted, SQLite, one district): yes, with conditions.** Every Stage B step is implemented, the audit trail and stock ledger exist (ARCH-05), SEC-03, SEC-05, SEC-06 and SEC-07 are resolved. Conditions: HTTPS in front of the container, real accounts in `CDS_CONFIG`, a backup before every upgrade (`scripts/backup-database.js`), and the open items below.
**Production-ready on SAP HANA: no.** Nothing has been run on SAP HANA; parallel-transaction behaviour is verified on SQLite only. Single sign-on (SEC-04) needs an identity provider.

## Status by area

| Area | State | Evidence |
| --- | --- | --- |
| Tests from clean install | passing | 300 / 300 backend; browser checks 185 / 185 (smoke), 24 / 24 (overdue reviews), 40 / 40 (local targets), 24 / 24 (households and two-person household-size change); 85 / 85 and 20 / 20 QUnit (11 Nov 2026) |
| Production build (HANA artifacts) | passing | `npm run build` |
| Docker image | not built | Docker Desktop not running on this Mac |
| SAP BTP deployment | not attempted | no `mbt`, `cf` or subaccount |
| CI on GitHub | not run | repository not pushed |
| SAP HANA behaviour (locks, calculated fields at runtime) | untested | statically reviewed only (see *Database verification status*); no HANA runtime available |
| Health endpoint | present, liveness only | `GET /health` → `{"status":"UP"}`; does not check the database |
| Readiness check including the database | missing | |
| Structured logs, correlation ids, metrics, alerting | missing | default CAP console logs |
| Backups and restore drill | procedure demonstrated, not automated | backup and restore demonstrated on disposable files in the B4.1 closure (see below); no backup job; RPO and RTO not defined |
| RPO / RTO | not defined | |
| Image and dependency scanning, SBOM | missing | `npm audit`: 0 production vulnerabilities today |
| Secret handling | basic | self-host users in `CDS_CONFIG` environment variable |
| Real vs test data separation | verified | real `reliefgrid.sqlite`: 0 business rows; tests and preview use in-memory databases; file unchanged across full test runs |

## Platform limitations (keep visible)

| Area | Position |
| --- | --- |
| SQLite runtime | Validated (in-memory and file databases, all tests) |
| SAP HANA compilation and build artefacts | Validated (`cds compile --dialect hana`, `cds build --production`) |
| SAP HANA runtime | **Not validated.** No HANA instance has been available. ReliefGrid must not be described as HANA-production-ready until it has run there, including row locking and the planning-settings joins. |
| Several processes on one SQLite database | Not supported as a deployment. Run one instance per SQLite file (ARCH-01). Confirmed in the B4.1 closure: two servers starting at once on one file fail with `database is locked` during schema evolution. |
| Production identity provisioning | Explicit administrator action: XSUAA role collections (*Coordinator*, *Planning Administrator*) are assigned to nobody on deployment; self-hosted users exist only if configured in `CDS_CONFIG`. |
| Test credentials | Kept in `test/helpers/test-users.js`, not in `package.json`; a test builds the production artefacts and fails if any password or test user appears in them. |

## Database verification status (B4.1 closure, 7 Nov 2026)

These three categories are kept separate. Nothing is listed under the third.

**VERIFIED ON SQLITE** (runtime, in-memory and temporary files):
- the B4.1 state sequence and calculations;
- the decision workflow, ETag and versions, compare-and-set and the scheduler claim (interleaving injected inside the transaction);
- simultaneous approvals and submissions;
- transactional activation with request flagging and the assessment record (failure injection);
- request reviews, including Keep durability across restarts;
- scheduled activation at start-up and on repeated runs; two processes on one file (exactly one activation and one record);
- the NET migration and its idempotency;
- backup, restore, refused rollback without restore, and forward recovery.

**STATICALLY REVIEWED FOR HANA** (CDS model, `cds compile --to sql --dialect hana` without errors or warnings, `cds build --production`, code review):
- *Decision in force*: a LEFT JOIN on camp, indicator, `status_code = 'APPROVED'` and `intent = 'DECIDE'`, all constants and keys, so the SQL is portable. It assumes at most one such row. No database constraint can express that (CDS has no partial unique index), so the application enforces it: compare-and-set plus the camp row lock. On HANA, two decisions in force would duplicate Stock rows in reads.
- *Types*: `NVARCHAR`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `INTEGER`; no SQLite-only function in B4.1 code or the model. `reviewDate` and `effectiveFrom` are `DATE` and are compared with an ISO date string (implicit conversion on HANA). `today()` is the UTC date.
- *Locking*: `SELECT … FOR UPDATE` on the decision and the camp (HANA row locks; ignored by SQLite). Lock order is always decision, then camp; Resolve Review locks only the request. No lock cycle was found.
- *Isolation*: HANA's default is READ COMMITTED. Correctness does not rely on isolation, because every decision change is a compare-and-set that checks the affected row count.
- *Transactions*: activation, flagging and the assessment record share the caller's transaction. Each scheduled activation runs in its own transaction.
- *Referential integrity*: CAP creates no foreign keys here (none on SQLite either); associations are checked in code.
- *Pre-existing, not B4.1*: the cover label `round(…) || ' days'` relies on implicit number-to-text conversion in concatenation.

Added by B4.2 (9 Nov 2026):
- VERIFIED ON SQLITE: target precedence and every state combination; history preservation; request flagging on a changed requirement; the review lifecycle; scheduled and missed-run activation; restart recovery; the upgrade of databases written by real B4.0 and B4.1 code; the B4.1 rollback by restore.
- STATICALLY REVIEWED FOR HANA: the local target join is a LEFT JOIN on camp, indicator and constants, like the applicability join, and compiles without errors or warnings. The effective figure is a plain `CASE`. `DecisionReviews` uses only standard types. `reviewStates` compares ISO date strings in JavaScript. "At most one local target in force" is enforced by the application (compare-and-set plus camp lock); no constraint can express it. No secondary indexes are declared (CDS has no portable syntax).

Added by B4.3 (9 Nov 2026):
- VERIFIED ON SQLITE: the household estimate including exact rounding; recorded and estimated kept apart; precedence of local targets; the assumption's change, audit and concurrency; history preservation; upgrade from real B4.2 code; B4.2 rollback by restore.
- VERIFIED ON SQLITE (11 Nov 2026): two-person household-size changes (propose, approve by another Administrator, reject with a reason, withdraw by the proposer), one waiting proposal at a time, simultaneous decisions giving one result, the append-only history with initiator and approver, and container requests flagged only when a household change alters their effective requirement. NOT VERIFIED ON HANA: the new table and columns compile to plain HANA DDL (NVARCHAR, DECIMAL, TIMESTAMP, INTEGER, a CASE expression), and the compare-and-set updates and `SELECT … FOR UPDATE` are standard; no HANA instance was available, so runtime behaviour, including row locking under concurrent approvals, is unverified.
- STATICALLY REVIEWED FOR HANA: `CampHouseholds` compiles without errors or warnings, using only `CAST`, `ROUND`, arithmetic and `CASE`. It assumes `CAST` of a decimal to `INTEGER` truncates, which must be confirmed on HANA.

**VERIFIED ON HANA RUNTIME**: nothing. No HANA instance has been available.

### HANA runtime verification checklist (before any HANA deployment)

1. Deploy with the HDI deployer to an empty HDI container; confirm that all tables and views are created and the reference data is loaded (NET with no per-person figure, rule `DECISION_REQUIRED`).
2. Run `npm test` against HANA (all suites, including the decision concurrency, failure-injection and request-review tests).
3. Two simultaneous approvals of one decision, and simultaneous submissions for one camp and indicator: exactly one succeeds.
4. Two application instances with a due scheduled decision: exactly one activation and one `DECISION_EFFECTIVE` record; confirm that the camp row lock blocks rather than deadlocks.
5. Read Stock after every test: never more than one row per camp and indicator (both in-force joins: applicability and local target).
6. Date handling: a review date of today is not overdue, yesterday's is; a decision effective today comes into force on approval; check camps whose local date differs from UTC.
7. Reference-data change at deployment: follow the checklist below.
8. Rollback rehearsal: back up the HDI container (or schema export), upgrade, restore, and start the previous release.
10. Households: confirm the estimate rounds up for several headcounts, including a size with a decimal (115 people at 4.6 is 25 households), and that a recorded count is used as it is.
11. Household governance on HANA: two Administrators approving the same proposal at the same moment give one result; a second proposal while one waits is refused; an approval flags only the container requests whose requirement changed.
9. Local targets: confirm the effective figure, classification and request quantity for one camp with and one without a local target, and that an assessment record keeps the local target after it is superseded.

## Backup, restore and rollback procedure (B4.1 closure)

The four operations are different, and only the first two can undo an upgrade:

| Operation | Meaning | Status |
| --- | --- | --- |
| Database restoration | Put back the database as it was at backup time | **Demonstrated** (disposable files) |
| Application rollback | Run the previous release | **Demonstrated only together with database restoration.** The previous release refuses to start on an upgraded database |
| Schema rollback | Remove what an upgrade added | **Not available.** CAP schema evolution only adds |
| Forward recovery | Start the new release again on the restored or current database | **Demonstrated.** The migration re-runs idempotently |

Procedure for every future stage on SQLite:
1. Stop the server, so that no write-ahead log is pending.
2. Copy `reliefgrid.sqlite` and record its SHA-256.
3. Keep the previous release's code at a known commit.
4. Upgrade.
5. To roll back: stop the server, restore the copy (verify the hash) and start the previous release.

A verified backup is taken before every stage (domain owner's condition from B4.1). The B4.2 backup, with hash manifests for the database and the B4.1 source, is in `~/reliefgrid-backups/2026-11-09-pre-B4.2`. Rollback from B4.2 to B4.1 was rehearsed with the real B4.1 code on disposable copies.

Work done between the backup and the restore is lost. Export or re-enter it, or roll forward instead. On HANA, use container backups or a schema export, and rehearse once (checklist item 8).

## HANA deployment checklist (carried from the B4.0 review)

On SAP HANA, reference data is deployed by the HDI deployer, outside the application, so the start-up detection of changed reference figures does not run. Before a HANA deployment that changes reference data:

1. Detect reference-data changes during deployment (compare the deployed CSV figures with the previous release).
2. Identify the affected camps and indicators.
3. Write new assessment records once the new reference data is in effect (trigger `REFERENCE_DATA_CHANGED`).
4. Keep every previous assessment.
5. Make sure a failed deployment cannot leave the application showing classifications that mix old and new figures.

The B4.1 start-up steps (scheduled decisions, flagging requests for indicators that are not established) run on any database, HANA included, but have not been run on HANA. With several instances, every instance runs them; the scheduler claim and the review-state check make repeated runs safe (verified on SQLite, static for HANA).

## Real database protection
`npm run watch` (development) connects to `reliefgrid.sqlite` and applies schema changes on every source edit. Keep it stopped while models are being changed or experiments run; before any schema change, list which running process uses which database (`lsof -nP -iTCP -sTCP:LISTEN`, and each process's profile). Tests, the browser smoke test and the preview server use in-memory databases or temporary files only. Reference data (indicators, code lists) is upserted from `db/data` on every start before the server listens; business tables are not written by this step (verified on 2 Nov 2026, see STAGE_B_DOMAIN_DECISIONS "B1 follow-up"). Reading the database with the `sqlite3` tool creates `-wal` and `-shm` files beside it; prefer file hashes for integrity checks.

## Database choice
SQLite with one connection serialises all writes. That is what keeps the current locking safe (ARCHITECTURE_AUDIT ARCH-01), and it suits one district control room. Multi-district or public donor use should move to SAP HANA Cloud (or another managed database) only after the race tests pass there.

## Ranked change plan

| Order | Stage | Items | Why first |
| --- | --- | --- | --- |
| 1 | D (small, urgent) | SEC-01 start-up guard, SEC-02 donor field allow-list — **done 2 Nov 2026** | removed the only P0 security issues |
| 2 | B | B1 citations, terminology, disclaimer and methodology page — **done 2 Nov 2026**. B2 not-assessed and not-counted states (DOM-03, DOM-04) — **done 3 Nov 2026**. B3 planning settings (DOM-09) — **done 4 Nov 2026**. B4.0 assessment history, B4.1 applicability decisions and B4.2 local targets accepted; B4.3 households implemented, awaiting the domain owner's acceptance. Open: response phase, functional counts (DOM-02 denominator, DOM-05, DOM-06); B5 food model (DOM-07) | stops the product making claims it cannot back; schema change needs migration planning |
| 3 | C | ARCH-01 locks, ARCH-02 over-receipt, ARCH-03 receipts, ARCH-04 delete, ARCH-05 ledger and audit; race and retry tests | trust in stock numbers |
| 4 | D (rest) | SEC-03 headers, SEC-05 rate limit, SEC-06 donor decision, SEC-07 test pages | hardening |
| 5 | E | UX-01 to UX-13, including replenishment preview and needs-attention list | operational usability, depends on B and C data |
| 6 | F | Docker build in CI, HANA run, readiness check, backups, logging | deployment proof |
| 7 | G | final acceptance report and README status | |

Open domain decision: a freshness policy for old stock counts (deferred from B3; old counts are never treated as uncounted). Items needing an owner decision before they can be built: DOMAIN_AND_SPHERE_REVIEW decisions 1-5; SEC-04 sign-in provider; SEC-06 donor eligibility; ARCH-06 deliveries to closed camps.

## Roadmap completion record (11 November 2026)

| Stage | Items | Status |
| --- | --- | --- |
| B | B4.4 response phase, B4.5 functional toilet and tap counts, B5 food energy (D10 option A) | done; owner rulings recorded in the stage documents |
| C | ARCH-01 row locks in raise, close and cancel; ARCH-02 over-receipt needs a reason; ARCH-03 delivery receipts (several shipments, accepted vs received, condition); ARCH-04 delete only untouched camps; ARCH-05 stock ledger and audit events; ARCH-06 late deliveries recorded and marked (owner ruling); ARCH-07 done in B3; ARCH-08 operation time zone; ARCH-09 camp count notice | done |
| D | SEC-03 security headers; SEC-05 pledge limits and withdraw-all; SEC-06 Donor role (owner ruling: controlled list); SEC-07 no test pages in builds or production | done. SEC-04 (identity provider) open: needs infrastructure and a product decision |
| E | UX-01 to UX-13, UX-14 (owner ruling) | done; UX-03 shows count dates but no stale warning (no stale-count threshold, B3 decision) |
| F | Docker build in CI; `/health` and `/ready`; verified backups; JSON logs in production profiles; Render blueprint and deployment guide | done. HANA run: not possible without a HANA instance |
| G | final report and README | done |

Verification on the released source: `npm test` 387 of 387; `npm run test:ui` all suites passed (smoke 187, overdue 24, local targets 40, households 24, phases 10, functional 8; QUnit 94 and 20); build and HANA compile without warnings; upgrade from the accepted B4.3 release and rollback rehearsal, 70 checks; mutation checks per stage (see SECURITY_AUDIT.md).

The self-hosted container configuration was found to resolve to SAP HANA and XSUAA, because `NODE_ENV=production` activates CAP's `production` profile after `selfhost`. Fixed with `CDS_REQUIRES_DB_KIND=sqlite` and `CDS_REQUIRES_AUTH_KIND=basic` in the Dockerfile; a test resolves the configuration as the container does. A local run with the container's environment confirmed SQLite, basic authentication, JSON logs and no test pages; the Docker image itself is built in CI (no Docker daemon was available locally).
