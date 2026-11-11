# Stage B4 — Applicability and Local Context: Proposal (revision 2)

4 November 2026. Planning document for domain-owner review. **Nothing in it is implemented.** B5 (food energy model) is out of scope.

Revision 2 incorporates the owner's decisions 1–5 and architectural corrections A–E of 4 November 2026. Items still open are listed in section 7.

**Governing principle (owner):** ReliefGrid must establish whether an indicator applies, establish the applicable requirement, and verify the available quantity or capacity before declaring a humanitarian supply gap.

## 1. Handbook evidence

Source: *The Sphere Handbook*, fourth edition, 2018 (copy and SHA-256 recorded in STAGE_B_DOMAIN_DECISIONS). Page numbers are the handbook's printed pages. Quotations are verbatim.

| Topic | Handbook text | Reference | Use in B4 |
| --- | --- | --- | --- |
| Water containers | "two water containers per household (10–20 litres; one for collection, one for storage)" | WASH, Hygiene promotion standard 1.2, key indicator, p. 100 | Container requirement per household |
| Household size | "Per household or group of four to five individuals: two family-sized cooking pots with handles and lids, one basin for food preparation or serving, one kitchen knife and two serving spoons" | Shelter and settlement standard 4 (Household items), key indicator, p. 259 | Context for the default household size of 5. The passage concerns cooking sets; for containers, 5 is a **ReliefGrid planning assumption** |
| Toilets, medium term | "Ratio of shared toilets — Minimum 1 per 20 people" | WASH, Excreta management standard 3.2, key indicator, p. 116 | Medium-term requirement |
| Toilets, by phase | "During the first phases of a rapid-onset crisis, communal toilets are an immediate solution with a minimum ratio of 1 per 50 people, which must be improved as soon as possible. A medium-term minimum ratio is 1 per 20 people, with a ratio of 3:1 for female to male toilets." | Excreta management standard 3.2, guidance note, p. 118 | Phase-dependent requirement. 1:50 is a first-phase figure for communal toilets in a **rapid-onset crisis**, to be improved as soon as possible, not a general minimum |
| Taps | "250 people per tap (based on a flow rate of 7.5 litres/minute)" | WASH, Water supply standard 2.1, key indicator, p. 106 | Tap requirement, valid only with its flow assumption |
| "Functional" | "Percentage of water systems/facilities that have functional and accountable management system in place" | Water supply standard 2.1, key indicator, p. 106 | Shows Sphere's use of "functional" for management systems. Sphere defines no functional toilet or tap count; counting only usable units is a **ReliefGrid operational interpretation** |
| Mosquito nets | "Long-lasting insecticide-treated nets where needed" | Shelter and settlement standard 4, key indicator, p. 259 | Applicability must be decided per camp; no ratio exists |
| Nets and malaria | "…such as insecticidal tents, curtains and bed nets help protect against malaria." | WASH, Vector control standard 4.2, guidance note, p. 125 | Context for the applicability decision |
| Context targets | Water: "It is never a 'maximum' … In the acute phase of a drought, 7.5 litres per person per day may be appropriate for a short time. In an urban middle-income context, 50 litres per person per day may be the minimum acceptable amount…" (p. 107). Living space: "4.5–5.5 square metres of living space per person in cold climates or urban settings…" (p. 254) | Water supply std 2.1 guidance, p. 107; Shelter and settlement std 3, key indicator, p. 254 | Examples of approved local target overrides |

## 2. State sequence (correction A)

Each indicator line is classified by the first rule that matches.

| # | State | When | Requirement, cover, shortfall, severity |
| --- | --- | --- | --- |
| 1 | **Not assessed** | Population or other required camp information missing, or no planning settings (B2, B3) | none |
| 2 | **Applicability not decided** | The indicator needs an explicit applicability decision and none is approved (mosquito nets, decision 3) | none |
| 3 | **Not applicable** | An approved decision says it does not apply | none |
| 4 | **Requirement not established** *(proposed, Q1)* | It applies but has no approved basis for its requirement. Example: nets marked applicable but with no approved target (decision 3 forbids a universal 1-per-2 rule) | none |
| 5 | **Not counted** | It applies and has a requirement, but the quantity or capacity has never been counted (B2; a counted zero stays a real zero). For toilets and taps also **Functionality not confirmed** (section 5) | none, except where the gap is certain (section 5) |
| 6 | **Critical / Needs attention / Met** | Applicability, requirement and measurement established | against the *effective requirement* |

States 1–5 are excluded from *Applicable Indicators Met*, from the critical gaps list and from request generation. `NOT_APPLICABLE` is the state reserved in B2.

The **effective requirement** is:
- an approved local target override where one is in force;
- otherwise the reference figure;
- for containers, worked out from recorded or estimated households (section 4);
- for toilets, from the approved response phase (section 6).

## 3. Local decisions and approval

### 3.1 Permissions (decision 1)

| Role | Propose | Approve |
| --- | --- | --- |
| Coordinator | Yes | No |
| Administrator | Yes | Yes, only if proposed by another person |
| Donor | No | No |

Two-person approval is mandatory. The backend refuses approval by the proposer by comparing user IDs, even for Administrators. Each step is enforced on the action itself, as in B3.

### 3.2 What a decision is

One append-only entity, `CampDecisions`, holds every local decision that can change a camp's classification. Each record is one of three kinds, always for one camp:
- **Applicability** (for one indicator): applies, or does not apply.
- **Local target** (for one indicator): a value in the indicator's reference unit, e.g. 7.5 L per person per day.
- **Response phase** (for the whole camp): first phase of a rapid-onset crisis, or medium term.

Each decision records:
- proposer and proposal time;
- source or reference, and reason;
- previous value and proposed value;
- approver and approval time;
- effective date;
- review date: mandatory for local targets, proposed for all kinds (Q2);
- version, used for stale-change rejection as in B3.

Supporting sources are mandatory when an indicator is declared not applicable (decision 3).

### 3.3 Lifecycle (correction E)

**Draft → Pending approval → Approved → (Review overdue) → Renewed / Superseded / Withdrawn**, and **Pending approval → Rejected**.

- **Draft:** editable by its proposer only. *Submit* makes it **Pending approval**, and from then on the record is never edited.
- **Approving or rejecting** names the version it acts on; a stale action is refused (409).
- **Rejected and withdrawn proposals** stay in the history.
- **Approved** decisions take effect on their effective date. That date can't be earlier than the approval time, so nothing is backdated and past assessments aren't rewritten (Q3).
- **Review overdue** is shown when the review date has passed. The approved value **stays in force**, the camp page and the Command Center attention area show the overdue review, and nothing changes silently (decision 2).
- **Renewed, Superseded and Withdrawn** are recorded only as a *new* decision that goes through the same approval. That new decision closes the old one; an approved decision is never edited or silently replaced.

### 3.4 Requests when an indicator stops applying (correction C)

Open or partly pledged requests for an indicator that becomes Not applicable are **flagged for review**, with their history intact. They are never cancelled automatically, and resolving them needs an authorised decision (Q7). Donor-facing wording follows the open UX-14 decision.

## 4. Households (decision 4)

- **`Camps.households`** is the recorded household count: optional, at least 1, at most the headcount. When it's recorded, it's used as is.
- **When it's missing**, households are estimated as headcount ÷ household size, **rounded up**. Example: 23 people at 5 per household gives 5 estimated households and 10 containers. The estimate is always labelled **Estimated**; recorded and estimated counts are separate fields and are never shown as each other.
- **The household size lives in a separate record**, the *household planning assumption* (default 5). It is not part of B3's five planning thresholds, which keep their responsibility unchanged. It gets B3's safeguards: a single record, a version, an append-only history, a reason, and Administrator-only changes. Whether a change also needs two-person approval is Q6.
- **Container requirement:** 2 × households (recorded, or estimated).
- **Migration impact:** for camps without recorded households, rounding up gives 2 × ⌈headcount ÷ 5⌉ instead of 0.4 × headcount. That's at most 2 more containers, and only where the headcount isn't a multiple of 5. This can reclassify a few container lines; the upgrade check will list every one (Q12).

## 5. Functional toilets and taps (correction B)

- **Each count records** total units and functional units for TOILET and TAP. Non-functional units are total minus functional.
- **Only functional units meet the requirement.**
- **Taps** are counted at the stated assumption of 7.5 L/min, shown wherever taps appear and on the methodology page, because Sphere's tap figure depends on it. A tap's flow is not measured in B4.
- **Existing toilet and tap counts** become **total units**, with functionality **not confirmed**. An old count never becomes a functional count. It also never becomes "Not counted": the recorded total stays visible.
- **Classification while functionality is not confirmed** (Q5): no gap or "met" is declared from the total, with one exception. When the total units are already below the critical threshold, functional units can only be fewer, so the line is classified **Critical (functionality not confirmed)**. A certain crisis is never hidden, and an uncertain one is never invented.

## 6. Response phase (decision 5)

- **Phases:** *First phase of a rapid-onset crisis*, communal toilets at a minimum of 1 per 50 people, to be improved as soon as possible (p. 118); or *Medium term*, 1 per 20 people (pp. 116, 118). Both are shown with this context and their source, never as universal requirements.
- **Changing the phase** uses the decision workflow in section 3: a Coordinator or Administrator proposes, an Administrator other than the proposer approves, and a reason and an effective date are required. The previous and new phase are recorded.
- **Existing camps keep Medium term** at the upgrade, which is today's 1:20. It's recorded as "Medium term — set at upgrade, not reviewed", not as an approval that never took place.
- **A new camp's initial phase:** Q2a.
- **Not in B4:** the 3:1 female-to-male ratio, accessible toilets (1 per 250) and distance (≤ 50 m). These need disaggregated counts.

## 7. Explainable history (correction D)

Today every figure is calculated on read with today's inputs, so yesterday's state would appear to use today's target. B4 adds:

- **An assessment record** (append-only) written whenever an input to a camp's classification changes:
  - a stock count or a delivery;
  - a change of population or households;
  - a planning-settings or household-assumption change;
  - a decision taking effect;
  - a change of response phase.

  It holds, per indicator line, the inputs and the result: settings version, household-assumption version, decision IDs and versions, response phase, population, households and their basis, the quantity and when it was counted, the effective requirement, the state, and the calculation time. On upgrade, one baseline record per camp is labelled "baseline at B4 upgrade".
- **The basis on every new supply request:** effective requirement, target source, settings version and decision ID, so a request can always be traced back to what it was raised against.
- **Live views are labelled** "calculated now". A history view shows what a camp's classification was at a given time, and why.

This is the largest new element, so it is proposed as the first sub-step (Q10).

## 8. Implementation proposal (after approval; one sub-step at a time)

| Step | Contents | Schema | Migration |
| --- | --- | --- | --- |
| B4.0 | Explainable history (section 7) | `AssessmentRecords` (append-only); basis fields on Requests | baseline record per camp; existing requests keep empty basis fields, marked "raised before B4" |
| B4.1 | State sequence, decision workflow, nets (sections 2, 3; decision 3) | `CampDecisions`; NET loses its reference ratio | every existing NET line becomes *Applicability not decided*; open NET requests flagged for review |
| B4.2 | Local target overrides, mandatory review date, Review overdue | target kind on `CampDecisions` | none (no overrides exist) |
| B4.3 | Households and the household planning assumption | `Camps.households`; `HouseholdAssumption` (versioned, with history) | containers from estimated households (rounded up); reclassified lines listed |
| B4.4 | Response phase via decisions | phase kind on `CampDecisions`; `Camps.responsePhase` with basis | existing camps Medium term, "set at upgrade, not reviewed" |
| B4.5 | Functional toilets and taps | `Stock.totalUnits`, `Stock.functionalUnits` | old counts → total units, functionality not confirmed |

Every step follows the B3 practice:
- **Validate first:** isolated SQLite, plus HANA compilation and build artefacts. HANA runtime stays unvalidated.
- **Upgrade copies** of the earlier test databases and of the real database, comparing every line's state against an independent recalculation, and list every reclassification.
- **Mutation-check** the security and integrity guards.
- **Run** the full regression and the production build.
- **Never** touch the real database or port 4004.

Tests per step, at minimum:
- each state and the order in which the states apply;
- self-approval refused for every role;
- coordinator approval refused;
- donor access refused;
- stale approvals refused;
- rejected and withdrawn decisions kept;
- review overdue keeps the value in force;
- no backdating;
- flagged requests never cancelled;
- every reclassification explained by an assessment record;
- the decision history can't be altered by any route;
- the decision and its audit entry are one transaction.

## 9. Risks

- **Calculation complexity.** The classification becomes a longer expression with more joins: decisions, settings, household assumption, camp. It will be validated first, as in B3.
- **History volume.** Records are written per event, not per read. One record per camp and event, holding nine lines, is small; retention is Q4.
- **Hidden needs.** States 2–5 remove a line from gap totals. The camp page and the Command Center will list them explicitly, so they're never just absent.
- **Approval bottleneck.** Phase changes and local targets wait for an Administrator. Pending items will be visible on the camp page and in the Command Center.

## 10. Questions for the domain owner

The owner's decisions 1–5 settled questions 1–8 of revision 1. These remain:

1. **Requirement not established (state 4):** do you agree with this state, for example nets that apply but have no approved target? Are there indicators other than nets that may have no default requirement?
2. **Review dates:** mandatory for local targets (decided). Should applicability and phase decisions also carry one?
   2a. **A new camp's initial response phase:** set by the coordinator at registration, then changed only through approval? Or pending approval from the start, with toilets showing *Requirement not established* until it's approved?
3. **Effective dates:** may they be in the future (scheduled changes), or only "on approval"? Backdating is excluded by correction D.
4. **Assessment history:** keep every assessment record indefinitely, or for a stated retention period?
5. **Functionality not confirmed:** accept the rule in section 5 (no classification from an old total, except a certain Critical)?
6. **Household planning assumption:** Administrator alone with a reason and audit (as B3), or two-person approval as for local decisions?
7. **Flagged requests:** who may resolve them (keep or cancel)? A Coordinator with a reason, or two-person approval?
8. **Review-overdue notices:** are the camp page and the Command Center attention area enough, or is another channel required?
9. **Withdrawing an approved decision:** confirm it's a new decision needing the same two-person approval.
10. **Sub-step order:** B4.0 (history) first, then B4.1–B4.5, each approved separately?
11. **Nets reference data:** remove the 1-per-2 ratio from the reference data entirely, so the NET requirement comes only from an approved local basis, and update the methodology page to match?
12. **Rounding up households:** accept that some existing container lines may be reclassified at the upgrade, with the full list shown in the migration report?

---

## B4.0 implementation record (4 November 2026)

Authorised scope: explainable assessment history only. B4.1–B4.5 and B5 not started; no decision, applicability, household, phase or functional-count fields were added.

**Model.** `AssessmentRecords` (one per camp per event: time, trigger, triggering record, label, actor, camp name and status, population, settings version and the five threshold values) with `AssessmentRecordLines` (per indicator: reference figure, unit, basis, requirement basis `REFERENCE_FIGURE`, citation, quantity, count time, state, severity, requirement, days of cover, coverage, shortfall). Requests gain `basisAssessment`, `basisRequirement`, `basisSource`, `basisSettingsVersion`, `basisTargetDays`, `basisCalculatedAt`, and the derived `raisedBeforeB4` (no basis recorded). Every value is copied, so a record explains its result after the live data changes.

**Events and transaction boundaries.** Written in the same transaction as the operation (a failed write rolls the operation back; tested for each):

| Trigger | Operation | Camps |
| --- | --- | --- |
| CAMP_REGISTERED | draft activation of a new camp | that camp |
| POPULATION_CHANGED | draft activation that changes the headcount | that camp |
| STOCK_COUNTED | `recordCount` | that camp |
| DELIVERY_CONFIRMED | `confirmDelivery` | that camp |
| SETTINGS_CHANGED | `PlanningSettings.change` (trigger ID = change-log ID) | every active camp |
| REQUESTS_RAISED | `raiseRequests` that creates requests; each request keeps its basis | that camp |
| REQUEST_SUBMITTED | `requestSupplies`; the request keeps its basis | that camp |

At start-up, each in its own transaction: `BASELINE` ("Baseline at B4 upgrade", stamped at the upgrade, ID derived from the camp, so idempotent across restarts and concurrent processes) for every camp without history, active or closed; `REFERENCE_DATA_CHANGED` when a reference figure (basis, per-person value, or the set of indicators) differs after the reference-data refresh; `SETTINGS_INITIALISED` when the settings record had to be recreated. The last two cover active camps that already had history.

Not recorded, because they change no classification input: pledges, withdrawals, request cancellation, camp closure (closed camps are not re-assessed by later settings changes), a Raise Requests run that creates nothing, and camp edits that leave the headcount unchanged.

**Access.** Both entities are `@readonly` projections in the coordinator service; no actions; the donor service exposes neither and donors cannot `$expand` a request's basis. Only the service code appends records.

**Verification.** `test/assessment-history.test.js` (22 tests: every trigger, snapshots equal to the live calculation, an independent recalculation of every stored state from the record's own inputs, earlier records unchanged after later settings/stock/population changes, request bases, rollback for six operations, every write route for Administrator and Coordinator including navigation, request-basis paths and `$batch`, donor isolation) and `test/assessment-baseline.test.js` (5 tests on a file database: baseline, pre-B4 requests untouched, idempotent restart, reference-data change, settings recreation). Mutation checks: ignoring recording failures fails all six rollback tests; dropping the stock-count recording fails the event test. Upgrade of copies of two B3-era databases and of the real database: one baseline per camp, every baseline line equal to the live state and to the independent recalculation, existing tables unchanged apart from the new empty basis columns and earlier approved migrations, idempotent second start. Concurrent baseline writing from three processes: never a duplicate.

**Limitations.** HANA: compilation and build artefacts only (`AssessmentRecords.hdbtable`, `AssessmentRecordLines.hdbtable`, basis columns, `raisedBeforeB4` in the Requests view); no runtime test. The baseline reflects the state at the upgrade only; nothing before it is reconstructed. Reference-data changes deployed by the HANA HDI deployer happen outside the application and are not detected at start-up on HANA. No user interface shows the history yet (read through OData by coordinators); a history view belongs with the later B4 steps or Stage E.

---

## B4.1 implementation record (7 November 2026)

Authorised scope: applicability states, decision workflow, mosquito nets. B4.2 to B4.5 and B5 not started: no local targets, household assumption, response phase or functional counts.

**State sequence** (first match wins; `Stock.assessment`): Not assessed (no people, or no planning settings) → Applicability not decided (indicator rule `DECISION_REQUIRED` and no decision in force) → Not applicable (decision in force says no) → Requirement not established (no reference figure) → Not counted → Critical / Needs attention / Met. Requirement, cover, coverage, shortfall and severity are calculated only for the last three; states 1–5 are excluded from Applicable Indicators Met, critical gaps and request generation. A counted zero stays a real zero once the indicator is established.

**Model.** `Standards.applicability` (`ALWAYS` or `DECISION_REQUIRED`); NET is `DECISION_REQUIRED` with no per-person figure. `CampDecisions` (append-only; applicability only): camp, indicator, intent (decide or withdraw), proposed value, previous decision and value, withdrawn decision, source, reason, proposer and time, review date, effective date (empty = on approval), version (also the OData ETag), status (code list: Draft, Pending approval, Scheduled, In force, Rejected, Withdrawn, Superseded), approver, rejecter and reason, in-force and end times, ending decision. `RequestReviews` (one row per review: cause, decision, flagged by and when, resolution, resolved by and when, reason); `Requests.review` and `currentReview`. Code lists `ApplicabilityOptions` and `ReviewResolutions` make the choices explicit. Stock lines reach the decision in force through an unmanaged association (no column).

**Workflow.** Coordinators and Administrators propose (draft or submit); only the proposer revises, submits or withdraws an unapproved proposal; only an Administrator other than the proposer approves or rejects (rejection needs a reason). Checks on every step: CAP requires the ETag as `If-Match` (428 without, 412 stale); the version must match (409); the decision in force must still be the one the proposal was made against (409); one pending or scheduled decision per camp and indicator; review date mandatory, after today and after the effective date; no backdating. A decision effective today comes into force in the approval transaction; a later one is Scheduled and brought into force by a job at start-up and every 10 minutes (UTC dates), each in its own transaction. Coming into force supersedes or withdraws the old decision, flags affected requests and writes a `DECISION_EFFECTIVE` assessment record (with decision ID, version and value) in one transaction. An overdue review only shows as "In force, review overdue" and in the Command Center; nothing changes by itself.

**Requests.** When an indicator stops being established, outstanding requests get a review (Review needed); nothing is cancelled. A flagged request is hidden from the Pledge Board and cannot be pledged; the ordinary Cancel is refused. Resolve Review (with a reason): Keep; or Cancel, which cancels a request without pledges, cancels only the unpledged remainder of a pledged one (pledges and deliveries kept), and is refused for a fully pledged one. Stock, deliveries and the request's calculation basis are never changed. Requests for an indicator that is not established are never offered to donors.

**UI.** Manage Camps: Propose Applicability Decision and Propose Withdrawal on the camp; an Applicability Decisions section; a decision page (proposal, previous value, source, dates, workflow, affected requests, approval note such as "You proposed this decision, so another Administrator must approve it"); Review column, Reviews section and Resolve Review on requests. Command Center: heatmap words Not decided / Not applicable / No requirement (no colour), a legend entry, a subtitle count and a Needs Decision tab (requests to review, pending, overdue, undecided, scheduled) that opens the item in Manage Camps. Methodology: NET without any ratio, the new states, the decision rules.

**Defect found and fixed during UI testing (pre-existing).** Bound actions reached through the camp page's navigation path (`Camps/stock/recordCount`, `Camps/requests/cancel`, `Camps/requests/pledges/confirmDelivery` and `withdraw`) looked up the camp instead of their own record. They now use the action's own key; a test calls every action through that path.

**Migration report.** The real database holds no camps, stock or requests, so its upgrade migrates no business rows (verified on a byte-identical copy). The data migration was verified on a temporary database put back into its pre-B4.1 state with NET requests in every situation (`test/applicability-migration.test.js`):

| Item | Result |
| --- | --- |
| 1. NET reference rows changed | 1 (per-person 0.5 → empty, rule → `DECISION_REQUIRED`); other indicators gain only the `ALWAYS` rule |
| 2. NET assessment lines affected | the active camp's NET line becomes Applicability not decided, explained by one `REFERENCE_DATA_CHANGED` record; B4.0 records unchanged |
| 3. NET requests flagged for review | 4 of 5 (open, partly pledged, fully pledged, partly delivered); the cancelled one is not flagged |
| 4. Pledged NET requests among them | 3 |
| 5. NET requests with deliveries among them | 1 |
| 6. Camps requiring an applicability decision | every active camp with people (1 in the test) |
| 7. Records that could not be safely migrated | 0 |

Flagging keeps the requests' own audit fields (who and when is on the review row); statuses, quantities, pledges, deliveries, stock and bases are unchanged; a second start changes nothing.

**Rollback.** B4.1 only adds tables, columns and rows; nothing is deleted or rewritten. *Corrected in the closure review below:* the earlier statement that the previous code "ignores the additions" was wrong. B4.0 code refuses to start on a B4.1-upgraded database, so rolling back the application requires restoring the database backup taken before the upgrade. That procedure was demonstrated in the closure review.

**Limitations.** HANA: compilation and build artefacts only. The overdue-review state is tested in the backend; the browser test cannot produce it because the browser test has no control of the clock. Scheduled decisions take effect within 10 minutes after midnight UTC, not at an exact local time. A request kept after review for an indicator that is not established stays invisible to donors until the indicator is established again.

---

## B4.1 closure review (7 November 2026)

Scope: closing B4.1 only. No B4.2 to B4.5 or B5 functionality was added.

### Rollback investigation

**What exists.** The repository has no commits, no objects, no branches, no reflog and no stash. No Time Machine destination or local snapshot is configured. No deployment was ever made, so there are no deployment artefacts; `gen/` is rebuilt from current sources.

**What was recovered.** The development editor keeps per-file checkpoint copies of every file it has edited, taken at each instruction from the domain owner. The checkpoint taken when the B4.0 approval arrived (2026-11-04 12:43:00 UTC, the B4.0/B4.1 boundary) holds 46 project files. Another 38 files have not been modified since that moment. That gives 84 of the 92 files of the B4.0 tree from genuine historical copies, among them every server-side file except the two `_i18n` text files.

**What was derived, not recovered.** 8 files were changed in B4.1 only by recorded scripts and have no checkpoint copy:
- `_i18n/i18n.properties` and `_i18n/messages.properties`;
- the Manage Camps `manifest.json`;
- the methodology `i18n.properties` and `formatter.js`;
- `heatmap.test.js` and `migration.test.js`;
- `db/data/reliefgrid-Standards.csv`.

They were derived by reversing the recorded B4.1 edits, with the edit text taken verbatim from the session transcript. Each was verified by re-applying the recorded edits and comparing the result with the current file byte for byte. `Standards.csv` also matches, byte for byte, its last full write before B4.1 (2 November). The other 7 have no independent copy. **The tree is therefore not proven to be byte-identical to B4.0**, and it is called the *recovered B4.0 tree*, not the original.

**Supporting evidence.** The recovered tree passes the B4.0 suites at exactly their recorded counts:
- 170 / 170 backend tests;
- 145 / 145 browser checks;
- 67 / 67 and 20 / 20 QUnit assertions.

**Demonstrated on disposable database files** (script in the session scratchpad, 39 checks passed; the project database was untouched):

| Operation | Result |
| --- | --- |
| Database backup | File copy of a stopped server's database; byte-identical by hash |
| B4.1 upgrade of real B4.0 data | Created by the B4.0 code: camp, counts, B3 settings change, requests, pledges, a delivery, 7 assessment records. The pledged NET request is flagged, not cancelled. The B4.0 assessment history (7 records, 63 lines), pledges, deliveries and stock are unchanged column for column. No row is lost |
| Application rollback **without** database restoration | **Not possible.** B4.0 refuses to start: its schema evolution reports "Dropping elements is not supported" for `Standards.applicability`. The refused start leaves the database byte-identical |
| Database restoration plus application rollback | Backup restored and B4.0 started on it. Every table equals its pre-upgrade content, with no B4.1 table. B2 calculations (water Critical), B3 settings change and stale refusal, B4.0 history, requests, pledges and deliveries all work. No record that existed at backup time is lost. B4.1 work done after the backup (one decision, one review) is not in the restored database: that is what a restore means |
| Forward recovery | B4.1 started on the restored database. NET ratio removed again, every outstanding NET request flagged, no decision invented. A second start changes nothing |
| Schema rollback | **Not available.** CAP schema evolution only adds; there is no down-migration |

### Request-review semantics

| Question | Behaviour (tested) |
| --- | --- |
| Does Keep remove the review flag? | Yes. The review becomes *Kept after review* with who, when and the reason; the request keeps its status, quantity and pledges |
| Does the request become visible again? | Only if its indicator is established for the camp. Donor visibility is derived from two conditions: no pending review, and an established indicator. Keep alone never exposes a request for an indicator that is not applicable, not decided or without a requirement, and a pledge is refused (not found) |
| Can a non-applicable indicator keep an active request? | Yes, active but not offered to donors. Pledges and deliveries already made are kept |
| Later applicability change | Indicator established again: the kept request is offered again, without a new review. Not established again through a decision: the request is reviewed again (new review row; earlier reviews kept). A request still waiting for its review stays off the Pledge Board even if the indicator applies again |
| Pledges and deliveries | Never changed by any review outcome |
| Reviewed more than once? | Yes. One row per review; resolving a resolved review is refused (409); of two simultaneous resolutions exactly one succeeds |

**Defect found and fixed.** The start-up sweep re-flagged every outstanding request for an indicator that was not established, including requests already kept. So a Keep was undone at every restart, with a new review row, although nothing had changed. The sweep now skips a request whose latest review was for the same state. A decision taking effect still always asks for a new review. The Keep message now tells the coordinator that donors see the request only while its indicator is established. Covered by tests; the mutation is caught.

### Overdue reviews in the browser

`test/ui/overdue.js` (23 checks, part of `npm run test:ui`) starts an isolated server with a test-only clock, `test/ui/helpers/clock.js`, loaded with `node --require`. No application code changed. Decisions are created with real dates, then the server's clock moves 5 days forward. Results:
- a future review date and a review date equal to today are not overdue;
- two overdue decisions are reported in the Command Center (Needs Decision) and the overview;
- superseded and withdrawn decisions are never overdue;
- an overdue decision stays *In force, review overdue*;
- no decision status or version, assessment, request, review or assessment record changes;
- the decision pages never say "expired".

### Terminology

The Command Center column for the underlying indicator (critical gaps and needs-attention tables) now reads *Indicator*: key `colIndicator` in `app/command/webapp/i18n/i18n.properties` and `Main.view.xml`. *Standard* remains only where it names a Sphere Handbook standard (the methodology citation label, the disclaimer). English is the only supported language.

### Concurrency and HANA portability fixes

- **Every decision status change is a compare-and-set** (`where ID and version`). A change based on a version that changed after it was read is refused (409) and rolled back.
- **The scheduler claims a due decision** by moving its version on from the one it read. Only the claiming instance activates it; another instance that loses the claim does nothing.
- **Proposing, submitting, revising, approving and activating lock the camp row** (`SELECT … FOR UPDATE`, always after the decision row). On HANA this serialises decisions per camp, so two proposals cannot both pass the "decision in force unchanged" or "one open proposal" checks. SQLite already allows one writer at a time. The lock cannot be shown to matter on SQLite.

Tests:
- an interleaved change and an interleaved claim, injected inside the transaction;
- simultaneous submissions;
- two scheduler runs in one process;
- two processes on one database file (`test/scheduler-instances.test.js`).

On SQLite, a second process either fails with `database is locked` (rolled back) or finds nothing to do. Two servers cannot even start at the same moment on one SQLite file, because start-up schema evolution reports `database is locked`. **SQLite remains single-instance.**

---

## B4.2 implementation record (9 November 2026)

Authorised scope: camp-specific local targets and mandatory review-date governance. B4.3 to B4.5 and B5 not started.

**Backup before the stage.** `~/reliefgrid-backups/2026-11-09-pre-B4.2` holds the development database and its sidecar files (`db.sha256`; database SHA-256 `ccf699ba1c20f474035497c41bac9ad1b3bc712c4faec5a9ec77667d7bf2ccfb`) and the complete B4.1 source (`source/`, 103 files, `source.sha256`). The folder is outside the project.

**Architecture.** One governance mechanism: `CampDecisions` gained a second kind, `TARGET`, beside `APPLICABILITY`. Local targets therefore use the existing workflow, ETag and version checks, compare-and-set, camp lock, scheduler, decision page and attention list. Each kind is governed separately: every in-force, open-proposal and supersede query filters on the kind, and so does the applicability join on Stock. One decision of each kind can be in force per camp and indicator, and an applicability and a target proposal can wait side by side. Removing any of these filters is caught by the mutation tests.

**What a target is.** The requirement per person (`Standards.perPerson`) in the indicator's existing unit, per day for consumables. It is not the replenishment target in days, which remains a global planning setting (B3). A value must be positive and fit `Decimal(12, 6)`; anything else is refused, never rounded. No upper or lower figure is imposed, because none is established. A proposal below the reference figure produces a warning for the proposer, and the approver sees both figures.

**Model.** `CampDecisions`: `targetPerPerson`, `referencePerPerson` (the figure when proposed), `previousTargetPerPerson`, `reviews`. New `DecisionReviews` (append-only) and code list `ReviewOutcomes` (CONFIRMED, CHANGE_PROPOSED). `Stock`: calculated `referencePerPerson`, `perPerson`, `targetBasis`, `targetBasisText`, and an unmanaged association `target`. `RequestReviews`: cause `TARGET_CHANGED` and calculated `causeText`. `AssessmentRecordLines`: `referencePerPerson`, `targetDecisionID`, `targetDecisionVersion`, `targetEffectiveFrom`, `targetSource`, and `requirementBasis` can now be `LOCAL_TARGET`. Reference data: only the new code list; `Standards.csv` is unchanged.

**Target precedence.** First match wins: no reference figure: no requirement (a target cannot create one); a TARGET decision with status In force and intent DECIDE: its value; otherwise the reference figure. Pending, draft, rejected, scheduled, superseded and withdrawn decisions never count, because only an in-force decision matches the join. An overdue review does not affect the join. The eight-state order is unchanged: the local target only supplies the figure used for the requirement, cover, coverage, shortfall and severity of the last three states (and the requirement shown on a not-counted line). Request generation uses the same figure.

**Workflow.** As for applicability: Draft, Pending approval, Scheduled or In force, Superseded or Withdrawn, or Rejected. Coordinators and Administrators propose, and only the proposer edits, submits or withdraws an unapproved proposal. Only an Administrator other than the proposer approves or rejects. A local target also requires a source. Ending one goes through `proposeTargetWithdrawal` or a replacement, with the same approval.

**Review governance.** `reviewState` is derived on read and never stored: NOT_DUE, DUE_TODAY, OVERDUE, COMPLETED, SUPERSEDED or WITHDRAWN. `completeReview` (Administrators) appends a `DecisionReviews` row with reviewer, time, outcome, explanation, next review date or resulting proposal, and decision version. CONFIRMED needs a future next review date. CHANGE_PROPOSED needs an open replacement or withdrawal of that decision; if that proposal is later rejected or withdrawn, the review is due again. A review never changes the decision's value or its review date, and never approves anything; only the version moves on, so a review made on a stale page is refused. A due or overdue review is shown (decision page, Needs Decision, Local Targets, overview) and changes nothing else. The same action serves applicability decisions.

**Scheduling.** A future effective date gives Scheduled. The start-up and 10-minute job (UTC dates, as in B4.1) re-checks that the decision it was approved against is still in force. If not, the decision is left Scheduled and reported as `SCHEDULED_BLOCKED`. A run missed while the server was down is caught up at the next run. Activation time is recorded as `inForceFrom`; the effective date stays as approved. Duplicate activation is prevented by the scheduler claim (compare-and-set on the version).

**History.** Each assessment line copies the figure used, the reference figure, the basis and the decision's ID, version, effective date and source. Activation writes a `DECISION_EFFECTIVE` record in the same transaction. Earlier records are never rewritten. Request bases name the local target and decision.

**Requests.** When a target decision takes effect and the requirement per person actually changes, outstanding requests for that camp and indicator are flagged for review (`TARGET_CHANGED`), using the B4.1 Resolve Review outcomes. They are hidden from donors until resolved. A kept request is offered again, because the indicator stays established. Quantities, pledges, deliveries, stock and calculation bases are not changed. A decision that leaves the figure unchanged flags nothing.

**Defects found and fixed during B4.2.** (1) `approve` marks a decision approved before `activate` runs, so reading the requirement through the Stock join inside that transaction could see two targets and intermittently miss the request flagging. The figures are now worked out from the decisions directly. (2) `If-Match: *` could stand in for the version the caller saw, bypassing the stale check (present since B4.1); it is now treated as no version. (3) Actions reached through another camp's path relied on CAP's ETag read, which `If-Match: *` skips; an explicit camp check now refuses them. (4) Every action's side-effect annotation named the binding parameter `_it`, but it is `in` in this service, so no page re-read after an action. A browser test showed the decision page keeping its old review status after Record Review; the network trace confirmed that no re-read was sent. All 20 annotations, present since B1, were corrected, and a test now refuses `_it`.

**Migration.** Additive only. Verified on disposable files with databases written by the real earlier code: the recovered B4.0 tree and the verified B4.1 source. Results (50 checks): every existing row unchanged column for column (decisions, reviews, requests, pledges, deliveries, stock, settings, assessment records and lines); classifications identical; a local target works on the upgraded data; a restart changes nothing; a fresh database starts cleanly. `test/target-migration.test.js` repeats the B4.1 upgrade on every test run, using a fixture written by B4.1 code.

**Rollback.** Rehearsed with the real B4.1 code. B4.1 refuses to start on a B4.2 database ("Dropping elements is not supported"), leaving it byte-identical. Restoring the pre-upgrade backup and starting B4.1 works with every classification as before and no record lost. Local target work done after the backup is lost by the restore. There is no schema rollback.

**Assessment history and launchpad.** The camp page has a read-only Assessment History section. Each record opens to its indicators as assessed, with the requirement per person used, its basis, the reference figure and the source. The launchpad asks who the user is before it builds its tiles: a user without a coordinator role sees only the Pledge Board and the methodology, and a failed sign-in goes to a plain sign-in page. This is display only; the services enforce every permission.

**Known limitations.** HANA runtime not verified. Scheduling works on UTC dates and activates within 10 minutes of the job. No secondary indexes: CDS has no portable way to declare them, and the decision queries are small at the expected size of tens of camps. "One in force" cannot be a database constraint, so it is enforced in the application. The application's status texts are English only and written in the server code.

---

## B4.2 acceptance (9 November 2026)

The domain owner accepted B4.2 and confirmed five decisions:
1. A local target means the per-person requirement.
2. Changed targets flag outstanding requests for review and hide them from donors until resolved.
3. No arbitrary numerical limits on local targets; deviations from the reference stay visible.
4. Record Review applies to applicability decisions too.
5. The approving Administrator may also record a review.

Recorded risk: one browser run failed with a Chrome "detached frame" error at a step unrelated to the code under test. It did not recur; the cause was not found. HANA runtime verification, production backup and restore, monitoring, and the production checklist remain mandatory before production.

## B4.3 implementation record (9 November 2026)

Authorised scope: households and the household planning assumption. B4.4, B4.5 and B5 not started.

**Backup before the stage.** `~/reliefgrid-backups/2026-11-09-pre-B4.3` holds the development database and sidecar files (`db.sha256`) and the B4.2 source (`source/`, `source.sha256`).

**Rule.** Water containers need 2 per household. `Standards.perHousehold = 2` is set for containers only. A count in `Camps.households` is used as it is. Without one, households are estimated as headcount / household size, rounded up. The estimate is never stored as a count: `CampHouseholds` exposes recorded and estimated as separate fields. Every other indicator stays per person.

**Precedence for containers.** Applicability comes first and is unchanged. An approved local target (B4.2) stays a per-person figure and takes precedence. Otherwise the household calculation applies. `Standards.perPerson = 0.4` stays stored for containers as the baseline a local target replaces; it no longer drives the calculation. Withdrawing a local target returns to households.

**Household assumption.** `HouseholdAssumption` is one record (default 5), separate from the B3 planning settings, with an append-only `HouseholdAssumptionChanges`. Only an Administrator changes it, with a reason and the version it was based on. The size must be at least 1 with at most one decimal; anything else is refused, not rounded. A change re-estimates only camps without a count, and writes an assessment for every active camp in the same transaction.

**Exact rounding.** The estimate is calculated in whole tenths of a person. A plain floating-point calculation rounded 115 / 4.6 up to 26; a test caught it. The expression uses only `CAST`, `ROUND`, arithmetic and `CASE`, because `CEILING` is not portable between SQLite and HANA.

**History.** Assessment records keep the recorded households, the estimated households, the basis, the household size and its version. Lines keep the requirement per household and the basis `HOUSEHOLD`. Recording or changing a count writes `HOUSEHOLDS_CHANGED`; a size change writes `HOUSEHOLD_ASSUMPTION_CHANGED`. Earlier records are never rewritten. Request bases name the households used, and say so when they were estimated.

**Requests.** Recording households or changing the size does not flag, change or cancel any request, pledge or delivery. That matches a change of population and of the B3 settings. A local target that takes over a household line is a target change, so B4.2's request review still applies, even if its figure equals the old 0.4.

**Upgrade (Q12).** Verified on a disposable database written by real B4.2 code (32 checks). No household count is invented. Every existing row is unchanged column for column. One `REFERENCE_DATA_CHANGED` record per active camp explains the change. B4.1 decisions and B4.2 local targets are unchanged. No request is flagged. Where a headcount does not divide by 5, the requirement rises by up to 1.6 containers; in the test, 201 people with 73 containers went from 80.4 required, Met, to 82 required, Needs attention. This is the only line that changed in the three test camps. The real development database holds no camps, so it has no lines to reclassify.

**Rollback.** Rehearsed with real B4.2 code: B4.2 refuses to start on a B4.3 database, leaving it byte-identical; restoring the backup and starting B4.2 works with the old classification and no record lost. There is no schema rollback.

**Known limitations.** HANA runtime not verified. `Standards.perPerson` for containers (0.4) still appears as the reference beside a local target, as a per-person equivalent. UI5 logs "Failed to drill-down into stock" once per stock row on entering Edit; this is identical on B4.2, has no visible effect, and is exempt only on the page edited in the browser test.

**Open for the domain owner.** Whether a household-size change also needs two-person approval (Q6 of this proposal). It is implemented as Administrator-only with a reason, version check and audit, as for the B3 settings.

## B4.3 governance decisions implemented (11 November 2026)

Authorised scope: the two open B4.3 decisions, ruled by the domain owner. B4.4 and B5 are not authorised. The B4.4 (response phase) and B4.5 (functional toilet and tap counts) work that had been started in the working tree was removed before this change: it is archived, unreviewed and not accepted, in `~/reliefgrid-backups/2026-11-11-B4.4-B4.5-archive` (source only, with a SHA-256 manifest). The working tree was restored from the verified `2026-11-11-pre-B4.4` source before any governance change was made.

**Backup before the change.** `~/reliefgrid-backups/2026-11-11-pre-B4.3-governance` holds the development database and sidecar files (`db.sha256`) and the B4.3 source (`source/`, `source.sha256`), each verified.

**Household size needs two Administrators (Q6).** The single-person `changeSize` action is gone. An Administrator proposes a size with `proposeSize` (size, reason, the version it is based on). The size in force does not change, no assessment is written and no request is flagged until another Administrator approves it. The proposer cannot approve or reject their own proposal (403); only the proposer can withdraw it; a rejection needs a reason. At most one proposal waits at a time: `HouseholdAssumption.pendingProposal` is set with a compare-and-set, so of two simultaneous proposals one is refused (409). Approval checks the proposal is still waiting and the assumption is still at the version it was based on, and moves the proposal to Approved with a compare-and-set, so of a simultaneous approval and rejection exactly one takes effect. `HouseholdSizeProposals` keeps every proposal: proposed and previous size, reason, proposer and time, outcome, decider and time, decision reason, and the version an approval produced; a decided proposal is never changed. `HouseholdAssumptionChanges` stays append-only and now records the initiator (`proposedBy`, `proposedAt`), the approver (`changedBy`, `changedAt`), the reason, the size before and after, the resulting version and the proposal. Changes made before this rule by one Administrator keep their record; no proposer is invented for them. The Command Center lists a waiting proposal under Needs Decision; the methodology page shows it with Approve and Reject for another Administrator and Withdraw for the proposer.

**Container requests are reviewed when household figures change them.** When a recorded household count is entered, corrected or removed, or an approved household-size change re-estimates households, every outstanding container request (Open, Partly pledged or Pledged) whose line's effective requirement changed is flagged for review, as for a local-target change (B4.2): cause `Households changed` or `Household size changed`, with the change and the requirement before and after in words (for example "Household size changed from 5 to 4 people per household: requirement 10 containers → 12 containers"), and, for a size change, a link to the change record. The effective requirement is the one shown on the line, so a line under a local target in force (B4.2 precedence) or decided not applicable (B4.1) does not change and flags nothing, and neither does a change that leaves the rounded household figure the same. A request already waiting for review is not flagged twice; a request kept after an earlier review is asked again by a new household change. Request quantities, pledges, deliveries, stock, the original request basis and earlier assessments are never changed; a flagged request is hidden from donors until reviewed, and the reason is shown in the Command Center and in the request's review history. A headcount change alone does not flag requests, as for any population change (see open points).

**Upgrade.** Verified on a disposable database written by real B4.3 code (68 checks, `verification/migrate-gov.js`). The proposals table is added empty; three columns are added to `HouseholdAssumption`, `HouseholdAssumptionChanges` and `RequestReviews`. Every existing row of every table is unchanged column for column and no row is added; the earlier single-person change keeps its record with no proposer; the size in force is unchanged; no indicator line changed requirement or state; B4.1 decisions, B4.2 local targets and B4.3 households are unchanged; no request is flagged at the upgrade. On the upgraded data the proposer cannot approve, a 4.6 → 5 change that keeps 23 people at 5 households flags nothing, and a 5 → 4 change flags the estimated camp's container request with its reason, but not the counted camp's nor the local-target camp's. A restart changes nothing.

**Rollback.** Rehearsed with real B4.3 code: it refuses to start on the upgraded database ("Dropping elements is not supported … HouseholdAssumption/pendingProposal"), leaving it byte-identical; restoring the backup and starting B4.3 works with the same classification and no record lost. There is no schema rollback. The real development database (`ccf699ba1c20…`) was not opened by any check.

**Verification.** `npm test` exit 0, 300 of 300 (284 earlier plus 16 in `test/household-governance.test.js`; `test/households.test.js` now proposes and approves with two Administrators and checks that a household change opens a review without changing the request). `npm run test:ui` exit 0: 185 smoke, 24 overdue reviews, 40 local targets, 24 households (including propose, approve by a second Administrator, history with both names, and the review reason in the Command Center), QUnit 85 of 85 and 20 of 20, with no console or page errors. Mutation checks: governance 17 of 19 (two equivalent mutants, see SECURITY_AUDIT.md); regression B4.1 9 of 9, B4.2 20 of 20, B4.3 24 of 24. `npm run build` exit 0 with no test users or passwords in `gen/`; HANA compile exit 0 without warnings; HANA runtime not verified. Scripts and logs are in the backup's `verification/` folder. The camp page stock table was also tidied at the user's request (compact columns, Record Count on the selected line; the "Requirement per Person in Use" column header now reads "Per Person in Use"), together with a new sign-in page and home page.

**Open for the domain owner.** (1) Whether a headcount change that alters the estimated households of a camp without a recorded count should also flag its container requests; today it does not, as for every population change since B3. (2) Whether a waiting household-size proposal should expire after a time; today it waits until it is approved, rejected or withdrawn. (3) Whether the Administrator who approved a size change may propose the next one; today any Administrator may, and two different people are always needed for each change.

## B4.4 and B4.5 implementation record (11 November 2026)

Authorised on 11 November 2026 together with the rest of the roadmap. The work archived earlier the same day (`~/reliefgrid-backups/2026-11-11-B4.4-B4.5-archive`) was merged onto the accepted B4.3 code with its governance change (three-way merge against the verified pre-B4.4 source; every conflict resolved by hand), then verified again.

**Owner rulings applied.** A phase change needs a Coordinator's proposal and a different Administrator's approval, a reason and an effective date, and records the previous and the new phase. Existing camps stay at Medium term. First phase 1 toilet per 50 people, medium term 1 per 20, each labelled with its Sphere context. Toilets and taps distinguish total, functional, non-functional and not confirmed; an earlier count never becomes a functional count; the 7.5 L/min tap assumption is stated. Confirmed defaults (owner, 11 Nov 2026): a new camp starts at Medium term until a phase decision; a toilet or tap total without a functional count is "Functionality not confirmed" (never Met or a gap), except a total already below the critical threshold, which stays Critical.

**Behaviour.** `CampDecisions` gains the PHASE kind; the camp's phase is derived (`CampPhases`) as decided or default. Stock lines use the first-phase figure where it applies (`PHASE_FIGURE`). Recording counts takes optional functional units for toilets and taps only (whole numbers, never above the total); only functional units meet the requirement; requests are never raised from an unconfirmed total, and Raise Requests says how many lines were skipped for that reason. Phase approvals flag outstanding requests whose requirement changed (`PHASE_CHANGED`). Assessment records keep the phase, its decision and the functional count.

**Verification.** `test/phases.test.js` (17), `test/functional.test.js` (12), browser tests `test/ui/phases.js` and `test/ui/functional.js`; mutation checks B4.4 10 of 10, B4.5 12 of 13 (one equivalent). Upgrade from the accepted B4.3 release: only toilet and tap totals were reclassified to "Functionality not confirmed"; no functional count and no phase decision was invented (part of the 70-check upgrade run in PRODUCTION_READINESS.md).
