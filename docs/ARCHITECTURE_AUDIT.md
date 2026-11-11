# Architecture Audit

Stage A of the senior review, 2 November 2026. No application code was changed for this audit.

## How the audit was done

| Step | Command / method | Result |
| --- | --- | --- |
| Clean copy of every project file (no `node_modules`, no database) | `tar` of all non-ignored files into an empty folder, then `npm ci` | installed, 0 vulnerabilities in production dependencies |
| Backend tests | `npm test` | 30 of 30 passed |
| Browser and UI unit tests | `npm run test:ui` | 30 of 30 checks passed, 38 of 38 QUnit assertions |
| Production build | `npm run build` | completed; SAP HANA artifacts generated |
| Behaviour probes | a throw-away script against an in-memory server in the `test` profile (mocked users `coordinator`, `donor`) | results quoted as "Probe En" below |
| Real database check | row counts in `reliefgrid.sqlite` | 0 camps, 0 stock, 0 requests, 0 pledges, 9 standards |

Every finding is marked **Confirmed** (reproduced or read directly in code) or **Risk** (plausible, not reproduced here). SAP HANA behaviour could not be tested on this machine; everything said about HANA is a Risk.

## Request path for each user journey

| Journey | UI | OData call | Handler | Database writes |
| --- | --- | --- | --- | --- |
| Register camp | Manage Relief Camps → Create, Save | `POST Camps`, `PATCH`, `draftActivate` | `relief-service.js:9` validation, `:19` after CREATE → `supply.ensureStock` (`supply.js:34`) | Camps row; 9 Stock rows |
| Edit camp | Edit, Save | `draftEdit`, `PATCH`, `draftActivate` | `relief-service.js:9` | Camps row (status is read-only) |
| Delete camp | Delete | `DELETE Camps(...,IsActiveEntity=true)` | none (framework default) | Camps row only — see ARCH-04 |
| Record stock count | Record Count | `Stock(..)/recordCount` | `relief-service.js:72` | Stock.quantity overwritten, countedAt |
| Raise requests | Raise Requests (FE action or Command Center) | `Camps(..)/raiseRequests` | `relief-service.js:23` → `supply.raiseRequests` (`supply.js:79`) | Requests rows |
| Manual request | Request Supplies | `Camps(..)/requestSupplies` | `relief-service.js:31` | one Requests row |
| Pledge | Pledge Board → Pledge Supplies | `DonorService Requests(..)/pledge` | `donor-service.js:8` → `supply.pledge` (`supply.js:123`) | Pledges row; Requests pledged/status |
| Confirm delivery | Command Center or request page | `Pledges(..)/confirmDelivery` | `relief-service.js:91` → `supply.confirmDelivery` (`supply.js:158`) | Pledge, Request, Stock (+received) |
| Withdraw pledge | Command Center or request page | `Pledges(..)/withdraw` | `relief-service.js:97` → `supply.withdraw` (`supply.js:188`) | Pledge, Request |
| Cancel request | request table | `Requests(..)/cancel` | `relief-service.js:81` | Request status |
| Close camp | object page | `Camps(..)/closeCamp` | `relief-service.js:56` | Camp status; Requests cancelled or shrunk |
| Overview KPIs | Command Center header | `overview()` | `relief-service.js:103` | read only |

## Findings

### ARCH-01 · P1 · Risk — locking relies on SQLite serialising every transaction
- **Evidence:** `supply.js:131`, `:163`, `:167`, `:190`, `:194` use `SELECT … forUpdate()`; `raiseRequests` (`supply.js:79`), `cancel` (`relief-service.js:83`) and `closeCamp` (`relief-service.js:56`) read without a lock.
- **Probe E1:** 10 concurrent pledges of half the request each → exactly 2 succeeded, pledged = requested. **Probe E3:** 5 concurrent `raiseRequests` → 9 requests, no duplicates. **Probe E11:** cancel racing a pledge → cancel refused (409), no stranded pledge.
- **Why it still matters:** SQLite here uses one connection, so transactions queue one after another. SAP HANA runs them in parallel; the locked paths should hold there, but `raiseRequests`, `cancel` and `closeCamp` could interleave (duplicate requests, a cancel landing after a pledge).
- **Change:** lock the camp row at the start of `raiseRequests` and `closeCamp`, lock the request in `cancel`, and re-read inside the lock.
- **Tests:** the three race probes above as permanent tests; run them against HANA (see PRODUCTION_READINESS).

### ARCH-02 · P1 · Confirmed — confirmDelivery accepts any received quantity
- **Evidence:** `supply.js:160-161` only rejects negatives. **Probe E14:** a pledge of 1 confirmed with 1,000,000 received → 200; stock rose by 1,000,000.
- **Impact:** one typo inflates usable stock and hides a real gap.
- **Change:** reject receipts above the pledged quantity unless a discrepancy reason is given; record the event (see ARCH-05).
- **Tests:** over-receipt refused; over-receipt with reason accepted and recorded.

### ARCH-03 · P1 · Confirmed — a delivery is a single event
- **Evidence:** `supply.js:165` requires status PLEDGED and `:170` sets DELIVERED. A second shipment for the same pledge cannot be recorded; damaged or rejected goods have no representation.
- **Change:** a `DeliveryReceipt` entity (quantity received, quantity accepted, condition, reason, receiver, time); the pledge becomes Delivered when receipts reach the pledged quantity or the coordinator closes it.
- **Tests:** two partial receipts; a damaged receipt does not raise usable stock.

### ARCH-04 · P1 · Confirmed — deleting a camp orphans its history
- **Evidence:** Camps → Stock / Requests are plain associations (`db/schema.cds:90-91`); there is no DELETE handler. **Probe E5:** deleting a camp returned 204 and left 9 stock rows, 9 requests and 2 pledges pointing at a missing camp.
- **Impact:** response history disappears from every screen; orphan rows stay in the database.
- **Change:** block Delete once a camp has counts, requests or pledges (Close Camp is the supported end of life); allow delete only for a camp with no history. Hide Delete in the UI accordingly.
- **Tests:** delete refused with history; delete allowed for an untouched camp.

### ARCH-05 · P1 · Confirmed — no audit trail or stock ledger
- **Evidence:** only `managed` fields (`createdBy/At`, `modifiedBy/At`) exist (`db/schema.cds:77,101,150,167`). `recordCount` overwrites `quantity` (`relief-service.js:72-79`); deliveries add to it (`supply.js:179-183`). Nothing records the previous value, who changed it, or why.
- **Change:** append-only `StockMovement` (count, receipt, adjustment, with before/after, actor, reason) and `AuditEvent` for pledge, withdraw, cancel, close. Stock on hand becomes the sum of movements, or is kept in step with them in the same transaction.
- **Tests:** every action writes exactly one movement or event; the ledger reconciles to on-hand stock.

### ARCH-06 · P2 · Confirmed — delivery can be confirmed for a closed camp
- **Evidence:** `supply.js:158-185` does not check camp status. **Probe E13:** 200 after `closeCamp`.
- **Change:** policy decision (it may be right to record goods that arrived late). If kept, record it explicitly and show it on the closed camp.

### ARCH-07 · P2 · Confirmed — operational thresholds are hard-coded
- **Evidence:** 2 / 5 days and 50 / 90 % live in SQL expressions (`db/schema.cds:128-140`); the 7-day target in `supply.js:8` and in the `shortfall` expression. They cannot be changed without a release.
- **Change:** a settings/profile entity (see DOMAIN_AND_SPHERE_REVIEW DOM-09).

### ARCH-08 · P2 · Confirmed — "today" is the UTC date
- **Evidence:** `supply.js:30`, `:128`; `app/command/webapp/model/formatter.js:25`.
- **Impact:** between midnight and 05:30 in India, needed-by dates, the past-ETA check and "Today/Overdue" labels are a day off.
- **Change:** a configured operation time zone used for all date-only logic.

### ARCH-09 · P2 · Confirmed — Command Center reads at most 1,000 camps
- **Evidence:** `Main.controller.js:65` (`requestContexts(0, 1000)`); server page limit is also 1,000 (`cds.env.query.limit.max`). A larger operation is silently truncated.
- **Change:** server-side aggregation for the heatmap plus paging, or a visible "showing first 1,000" notice and filters.

### What is sound and should be kept
- Two services split by audience; all rules enforced in handlers, not the UI.
- Draft only on camp master data; stock, requests and pledges outside the draft (no overwrite on save).
- Gap metrics computed in the database, so they filter and sort correctly; `round()` and `||` compile for HANA (build verified).
- Real and test data separated: tests and the 4005 preview use in-memory databases; the real file has no camps.
- Server page limit of 1,000 applies (`$top=100000` capped).

## Status (11 November 2026)

| Finding | Status |
| --- | --- |
| ARCH-01 | Resolved: `raiseRequests`, `closeCamp` and manual requests lock the camp row; `cancel` locks the request; each re-reads inside the lock. Race tests: five simultaneous raises, cancel racing a pledge, close racing a pledge. On SQLite transactions are serialised anyway; a HANA run is still needed. |
| ARCH-02 | Resolved: more received than pledged needs a discrepancy reason and is recorded as an over-receipt |
| ARCH-03 | Resolved: `DeliveryReceipts`; several shipments; received and accepted quantity; condition; a pledge is delivered when everything arrived or the coordinator closes it with a reason; what never arrived or was not usable goes back on the board |
| ARCH-04 | Resolved: deleting a camp with counts, requests or decisions is refused (409); Delete is hidden for such camps; an untouched camp is deleted with its empty lines and registration record, and the deletion is audited |
| ARCH-05 | Resolved: `StockMovements` (count and receipt, before and after, actor, reason) and `AuditEvents` (pledge, withdrawal, receipt, closed pledge, request created, raised, cancelled, camp closed and deleted); the ledger reconciles to stock on hand (tested). Earlier events are not reconstructed. |
| ARCH-06 | Resolved by owner ruling: receipts for a closed camp are recorded, marked received after closure and shown on the camp |
| ARCH-07 | Resolved in B3 (planning settings) |
| ARCH-08 | Resolved: `srv/lib/clock.js`; operation time zone from `RELIEFGRID_TIME_ZONE` or `cds.reliefgrid.timeZone` (default UTC); an unknown zone stops the start |
| ARCH-09 | Resolved: the Command Center counts all active camps and shows a notice when more than the 1,000 read are active |

