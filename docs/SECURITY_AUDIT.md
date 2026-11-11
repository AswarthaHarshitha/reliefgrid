# Security Audit

Stage A, 2 November 2026; SEC-01 and SEC-02 resolved the same day (Stage D, first part). Method and probe set: see ARCHITECTURE_AUDIT.md.

## Findings

### SEC-01 · P0 · Resolved 2 November 2026 — development sign-in could face the network
- **Original evidence:** `package.json` `[development].auth = "dummy"`, chosen whenever `NODE_ENV` is not `production`. CAP calls `app.listen(port)` without a host (`node_modules/@sap/cds/server.js:67`), so Node bound to every interface: `lsof` showed the development server on `*:4004`. Anyone on the same network could act as a coordinator, and `npm start` on a server did the same.
- **Fix:**
  - `package.json`: the `development` and `test` profiles set `server.host` to `localhost`. `production` and `selfhost` set no host and still listen on all interfaces.
  - `server.js` (`bootstrap` hook) passes the host (`HOST` environment variable, else `cds.env.server.host`) to `app.listen`.
  - If authentication is `dummy` or `mocked` (`srv/lib/network-guard.js`), startup stops with a clear message before listening unless the host is a loopback address (`localhost`, `127.x.x.x`, `::1`). Once listening, the guard checks the address actually bound, and exits if it is not loopback.
- **Verified:** the development server now listens on `[::1]:4004`. `HOST=0.0.0.0`, `HOST=::` and the machine's LAN address are refused before listening. Self-hosted mode (basic auth) still listens on all interfaces, and returns 401 without credentials and 200 with them.
- **Not covered by a test:** the post-listen check. It only matters if `localhost` resolves to a non-loopback address, which cannot be set up portably in a test. `isLoopback` itself is unit-tested.
- **Tests:** `test/startup.test.js` (9 tests).

### SEC-02 · P0 · Resolved 2 November 2026 — donors could see who created other donors' pledges
- **Original evidence:** `srv/donor-service.cds` excluded only `donorContact`. Probe E6 showed `createdBy` and `modifiedBy` (user ids, often e-mail addresses) to every donor.
- **Fix:** DonorService `Pledges` is now an explicit allow-list: `ID`, `request`, `donor`, `quantity`, `receivedQuantity`, `eta`, `status`. Everything else is absent from the donor service model itself, not hidden in the UI. No database change. The ReliefService projection is unchanged, so coordinators keep contacts and audit fields.
- **Verified:** donor reads (direct, by key, through the pledge action response, `$expand=pledges` from Requests) contain only the public fields. `$select`, nested `$expand(...$select)` and `$filter` on `createdBy`, `modifiedBy` or `donorContact` return 400. The donor `$metadata` no longer declares those properties.
- **Regression check:** run against the previous projection, 6 of the new tests fail; with the fix they all pass.
- **Tests:** `test/services.test.js`, suite `donor privacy` (8 tests).

### Follow-up verification of SEC-01 and SEC-02, 2 November 2026
- **Associations reachable by donors:** read from the donor `$metadata`, these are Requests → hazard, standard, sector, priority, status, pledges; Pledges → request, status; Standards → sector; and each code list's texts. None of these entity types declares `createdBy`, `modifiedBy`, `modifiedAt`, `donorContact`, `contactPhone`, `coordinator`, `latitude`, `longitude`, `childrenUnder5` or a `camp` association. No leak was found through `$expand=request`, nested `$expand` up to four levels, `$expand=*` on Requests, Pledges and Standards, or navigation paths. `$expand=donor` returns 400, because `donor` is a plain field. `$search` matches only donor-visible fields, so hidden contacts cannot be probed. `$orderby` on a hidden field returns 400.
- **Regression tests:** suite `donor privacy` in `test/services.test.js`: a deny-list over every donor entity type in `$metadata`, and 8 expansion paths. Temporarily exposing `camp` on Requests made 8 of these tests fail.
- **Actual bound address:** the post-listen check is `enforceLoopbackBinding` in `srv/lib/network-guard.js`, wired in `server.js`. It reads `server.address()`, accepts `127.x`, `::1` and `::ffff:127.x`, and otherwise closes the server and exits with code 1. An address it cannot read is treated as non-loopback. Tests in `test/startup.test.js` cover IPv4, IPv6, IPv4-mapped and unknown addresses (with an injected stop), a real socket on 127.0.0.1, and a real server process whose reported address is replaced by a test-only preload (`test/fixtures/report-public-address.js`): it exits with code 1 and never reports listening. With the wiring in `server.js` removed, that process test fails.

### SEC-03 · P1 · Confirmed — no security headers on the self-hosted server
- **Evidence:** **Probe E9:** no `X-Content-Type-Options`, `X-Frame-Options` / `frame-ancestors`, `Content-Security-Policy`, `Strict-Transport-Security`.
- **Change:** a small middleware in `server.js` setting these; CSP must allow `https://ui5.sap.com`. On BTP the approuter is the edge, but the service should send them too.
- **Tests:** header presence on an app page and an OData response.

### SEC-04 · P1 · Confirmed — self-hosted sign-in is basic auth with plain-text passwords
- **Evidence:** `[selfhost]` uses `auth.kind: basic`; users and passwords come from `CDS_CONFIG` in plain text. No lockout, no expiry, no password policy.
- **Change:** acceptable only for a controlled pilot behind HTTPS. For wider use: an OpenID Connect provider (SAP IAS, or any OIDC provider through a proxy) — needs a product decision.

### SEC-05 · P1 · Risk — no limit on pledges per user
- **Evidence:** `donor-service.js:8-15` accepts any number of pledges. A single account can pledge the whole board and block real donors until coordinators withdraw each pledge.
- **Change:** per-user rate limit on `pledge` and a cap on open pledges per user; coordinators can withdraw all pledges of a user.

### SEC-06 · P1 · Decision — who is a donor?
- **Evidence:** `srv/donor-service.cds:8` `@requires: 'authenticated-user'`.
- **Question for the owner:** controlled list of known organisations (role `Donor`), or open self-registration? Organisation verification depends on this.

### SEC-07 · P2 · Confirmed — QUnit test pages ship to production
- **Evidence:** `mta.yaml` copies all of `app/` into the service; `app/command/webapp/test/` is included.
- **Change:** exclude `*/test/` from the copy and the Docker image.

### Verified as working
| Check | Result |
| --- | --- |
| Anonymous call to either service | 401 (test suite) |
| Donor calling ReliefService | 403 (test suite) |
| Donor creating a request directly | refused (test suite) |
| Donor `$select=donorContact` on Pledges | 400 (Probe E6b) |
| Donor `$metadata` entity sets | only Requests, Pledges and code lists; no Camps, Stock or CampHealth (Probe E7) |
| Cross-site form-style POST (`text/plain`) to an action | 415 (Probe E8); JSON needs a CORS preflight, and no CORS headers are sent |
| Status set through the draft (`status_code: CLOSED`) | ignored; camp stays ACTIVE (Probe E4) |
| Over-long donor name (500 characters) and fractional quantity | 400 (Probe E10) |
| Production profile without SAP HANA binding | refuses to start (fails closed) |
| Contact details in logs | not present; request bodies are not logged |

## Not yet verified
- XSUAA role collection behaviour and approuter CSRF handling on a real BTP subaccount.
- Rate limiting, session expiry and lockout in any profile (none exist).
- Data retention and deletion of donor contact details (no policy exists yet).

## B3 change (4 Nov 2026): Administrator role

A second role, `Administrator`, was added (approved by the domain owner) for one capability only: changing the planning settings through the bound action `ReliefService.PlanningSettings.change` (`@requires: 'Administrator'`). Administrators also need `Coordinator` to reach the service and the apps. Coordinators can read the settings and their change history; donors cannot read either (the donor service does not expose them, and the coordinator service refuses donors). Tests cover each of these. In the development profile the dummy user has every role, which is acceptable only because that profile is bound to loopback (SEC-01).

### B3 security verification (4 Nov 2026)

Enforcement points: `@requires: 'Coordinator'` on ReliefService (donors refused for every entity, function and `$batch`); `@requires: 'Administrator'` on the bound action `PlanningSettings.change` itself (checked by CAP before the handler runs, whichever URL reaches it: direct, unqualified, through `Stock/settings` or `Camps/settings`, or inside `$batch`); `@readonly` on `PlanningSettings` and `PlanningSettingsChanges` (no create, update, replace or delete, also not through navigation, `$batch` or a camp draft). The donor service exposes neither entity. Tests: `test/planning-security.test.js`; removing the role annotation makes them fail.

Fixed during verification:
- **Lost updates.** Two administrators editing at the same time could each save, the second silently replacing the first. Every change now names the version it was based on; a stale version is refused (409) and nothing is saved or logged. Of two simultaneous changes from the same version exactly one succeeds.
- **Concurrent initialisation.** A second process creating the settings record at the same moment failed with "database is locked". Creation now retries and accepts the record another process created; the primary key keeps it to one record.
- **Production role collection.** `mta.yaml` now defines an unassigned *Planning Administrator* collection; XSUAA assigns role collections to nobody on deployment, so a subaccount administrator must assign it explicitly.

Remaining risks:
- ~~Test users in the build output.~~ Resolved 4 Nov 2026: the mocked test users moved from `package.json` to `test/helpers/test-users.js`, which the test files load through `CDS_CONFIG`. `package.json` and the production build now contain no users or passwords (the `[test]` profile only says `auth: "mocked"`); a test runs `cds build --production` into a temporary folder and fails if any password or test user appears.
- Two server processes starting at the same instant on one SQLite file can make one fail to open the database (driver, before application code). It fails loudly; ReliefGrid runs as a single instance per SQLite file (ARCH-01).
- SAP HANA runtime is not validated (no HANA available); row locking (`SELECT ... FOR UPDATE`) and the joins are verified only as generated artefacts.

### B4.0 assessment history (4 Nov 2026)

`AssessmentRecords` and `AssessmentRecordLines` are `@readonly` in the coordinator service (Coordinator role), have no actions and are not exposed to donors. Create, update, replace and delete are refused for Administrators and Coordinators directly, through navigation (`AssessmentRecords/lines`, `Requests/basisAssessment`), on the request basis fields, and in `$batch`; tests in `test/assessment-history.test.js`. Records are appended only by service code inside the transaction of the operation that caused them.

### B4.1 applicability decisions (7 Nov 2026)

Enforcement: `@requires: 'Coordinator'` on ReliefService (donors refused everywhere, including `attention()`); `@requires: 'Administrator'` on `CampDecisions.approve` and `rejectProposal`; the handlers refuse the proposer as approver or rejecter by comparing the session user ID (never a client value); `CampDecisions` and `RequestReviews` are `@readonly` with no deep or navigation writes; `version` is the ETag, so CAP requires `If-Match` on every decision action (428 / 412). The donor service exposes neither entity, hides requests under review or for an indicator that is not established, and refuses pledges on them. Tests: `test/decisions.test.js` (30), mutation-checked (role requirement, self-approval check, action key, request flagging, assessment record).

### B4.1 closure review (7 Nov 2026)

Re-validated server-side (`test/decisions.test.js`, 41 tests):
- a coordinator cannot approve or reject, including through direct, unqualified and navigation URLs;
- no one can submit, revise or withdraw another user's proposal (403 `DECISION_PROPOSER_ONLY`);
- an Administrator cannot approve or reject their own proposal;
- reasons are required;
- donors are refused decisions, reviews, `attention()`, proposals, withdrawals, Resolve Review and `$batch` approval;
- create, update, delete, `$batch` and deep updates to decisions and reviews are refused for every role;
- a missing `If-Match` is refused (428) and a stale one too (412 or 409);
- identity comes from the session only: extra `proposedBy`, `approvedBy` or `status_code` parameters have no effect.

New guards:
- compare-and-set on every decision transition;
- the scheduler claim;
- camp row locks;
- the start-up sweep no longer undoes a Keep.

Mutation checks: all 9 caught. They cover the role requirement, the self-approval check, the action key, request flagging, the assessment record, the Keep sweep, compare-and-set, the scheduler claim and the donor review filter. The camp lock cannot be mutation-tested on SQLite.

### B4.2 local targets (9 Nov 2026)

Enforcement is server-side and reuses B4.1: `@requires: 'Coordinator'` on ReliefService; `@requires: 'Administrator'` on `approve`, `rejectProposal` and `completeReview`; the proposer check compares the session user ID; `CampDecisions` and `DecisionReviews` are `@readonly`; the version is the ETag.

New in B4.2:
- an action reached through a camp path must belong to that camp (404 otherwise, also with `If-Match: *`);
- `If-Match: *` no longer stands in for the version the caller saw;
- a draft can only be revised by the action of its own kind.

Verified in `test/targets.test.js`:
- coordinators cannot approve, reject or record reviews;
- self-approval and self-rejection are refused;
- donors are refused decisions, reviews, `localTargets()`, `attention()`, proposals, withdrawals and approvals, and the donor metadata has no target field;
- create, update and delete, navigation, deep updates and `$batch` writes to decisions, reviews and `Standards` are refused and change nothing;
- client-supplied identity, status and kind fields have no effect;
- cross-camp read and action are refused;
- a missing ETag gives 428, a stale one 412;
- simultaneous submissions and approvals produce one result.

Mutation checks: 20 of 20 caught, including role authorization, self-approval, camp isolation, duplicate activation and the kind filters. The camp row lock still cannot be mutation-tested on SQLite.

### B4.3 households (9 Nov 2026)

Server-side only. `changeSize` requires `Administrator`; the version it was based on is checked twice (locked read and compare-and-set). `HouseholdAssumption`, `HouseholdAssumptionChanges` and `CampHouseholds` are `@readonly`. Verified in `test/households.test.js`: coordinators and donors cannot change the size; direct and unqualified action URLs, entity create, update and delete and `$batch` are refused and change nothing; a client cannot set an estimate; donors are refused all household data, and the donor metadata exposes only the public per-household reference figure. A stale version gives 409; of two simultaneous changes one goes through; an injected failure rolls the whole change back.

Mutation checks: 23 of 23 B4.3 mutations and 20 of 20 B4.2 mutations caught.

### B4.3 governance: household size and container request review (11 Nov 2026)

Server-side only. The single-person `changeSize` action was removed. `proposeSize` and the proposal actions `approve`, `reject` and `withdraw` require `Administrator`. The proposer cannot approve or reject (403); only the proposer can withdraw (403 otherwise); a rejection needs a reason (service `mandatory` and library check). At most one proposal waits: a compare-and-set on `HouseholdAssumption.pendingProposal` refuses a second (409). Approval re-checks the assumption version at the locked read and in its compare-and-set (409 when it moved on), and moves the proposal from Pending with a compare-and-set, so simultaneous approvals or an approval and a rejection give exactly one result. `HouseholdSizeProposals` and `HouseholdAssumptionChanges` are `@readonly`; entity create, update and delete, unqualified action URLs and `$batch` are refused (tested). Donors cannot read the proposals and see none of them in `$metadata`. Requests flagged by a household change are hidden from donors until reviewed; no request quantity, pledge or delivery is changed by a flag (tested by snapshot).

Mutation checks: 17 of 19 governance mutations caught. The two not caught are equivalent here and recorded: removing only the atomic part of the pending-proposal check (SQLite serializes write transactions, so the locked read already refuses; as for the B4.2 camp row lock) and removing only the library check for a rejection reason (CAP's `mandatory` refuses a blank reason first; removing both layers is caught). Regression: B4.1 closure 9 of 9, B4.2 20 of 20, B4.3 (adapted to the proposal flow) 24 of 24.

### Roadmap stages C, D and E (11 Nov 2026)

| Finding | Status |
| --- | --- |
| SEC-03 security headers | Resolved: `srv/lib/http-hardening.js` sets CSP (SAPUI5 CDN allowed), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS on HTTPS; tested on app pages, OData responses and refusals |
| SEC-04 basic auth | Open: needs an identity provider (product and infrastructure decision) |
| SEC-05 pledge abuse | Resolved: caps on open pledges per account and pledges per hour (configurable, `cds.reliefgrid.pledges`), 429 with a message; coordinators withdraw all open pledges of one account with a reason, each audited |
| SEC-06 who is a donor | Resolved (owner ruling: controlled list): the donor service requires the `Donor` role; a Donor role template and collection exist, assigned to nobody; the home page asks `AccessService` which apps to show |
| SEC-07 test pages | Resolved: refused outside development and test; removed from the Docker image and the BTP build; CI checks the image |
| Container profile | Found and fixed: the self-hosted image resolved to SAP HANA and XSUAA (see PRODUCTION_READINESS.md); a test now resolves the container configuration |

Ledger and audit: `StockMovements`, `AuditEvents` and `DeliveryReceipts` are read-only through the services and invisible to donors; every count and receipt writes exactly one movement and every supply operation one event, in the same transaction (tested, including that a failed operation writes neither).

Mutation checks on the final source: roadmap stages 29 of 30 (the survivor: removing only the library check for a withdraw-all reason, which CAP's `mandatory` refuses first); regression B4.1 closure 9 of 9, B4.2 20 of 20, B4.3 24 of 24, B4.3 governance 17 of 19 (two equivalent, recorded above), B4.4 10 of 10, B4.5 12 of 13 (the survivor writes `undefined` where the code writes `null`; both store NULL).

