# Test Coverage Gaps

Stage A, 2 November 2026. Current suites (all passing from a clean install): 11 domain tests (`test/supply.test.js`), 19 service tests (`test/services.test.js`), 38 QUnit assertions, 30 browser checks (`test/ui/smoke.js`).

## Endpoint and action coverage

| Endpoint / action | Covered by tests | Gap |
| --- | --- | --- |
| Camps draft create / activate | yes | edit of an existing camp; discard |
| Camps DELETE | no | orphaning behaviour (ARCH-04) |
| raiseRequests | yes (single caller) | concurrent callers; target-days limits 0 and 91 |
| requestSupplies | yes | closed camp; zero quantity |
| closeCamp | yes | in-transit pledges after closure; second close |
| recordCount | yes | stale and uncounted states (not modelled yet) |
| cancel | partly (refused while pledged) | successful cancel; race with pledge |
| confirmDelivery | yes | over-receipt (ARCH-02); concurrent confirm; closed camp |
| withdraw | yes | concurrent withdraw and confirm |
| overview() | yes | camps with headcount 0 |
| DonorService pledge | yes | concurrent over-pledge; past ETA; inactive camp |
| DonorService Pledges read | contact hidden | createdBy / modifiedBy leak (SEC-02); `$expand=pledges` |
| `$metadata` for donors | no | entity-set allow-list |
| Production start-up | no | auth guard (SEC-01) |

## Tests to add, by stage

| Stage | Test |
| --- | --- |
| B | standard not applicable is excluded from the indicator score; household-based containers; empty camp is "not assessed"; uncounted vs counted zero; stale counts; local override with history |
| C | 10 concurrent pledges cannot exceed the request; 5 concurrent confirms add stock once; concurrent withdraw vs confirm; concurrent raiseRequests creates no duplicates; cancel vs pledge; two partial receipts; damaged receipt does not raise usable stock; over-receipt needs a reason; every stock change writes a movement; camp with history cannot be deleted; closing with in-transit pledges |
| D | start-up refuses insecure auth on a public interface; donors never receive createdBy / modifiedBy / donorContact (direct, `$expand`, `$select`); security headers present; pledge rate limit |
| E | needs-attention list content; replenishment preview matches published lines; keyboard path through each app; 320 / 768 / 1024 px renders |
| F | Docker image builds and passes the smoke test in CI; SAP HANA integration run of the race tests; backup and restore of the SQLite file |

The concurrency probes used in this audit (`E1`, `E2`, `E3`, `E11`) passed on SQLite and should become permanent tests in Stage C.
