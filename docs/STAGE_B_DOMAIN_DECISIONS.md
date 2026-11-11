# Stage B — Domain Evidence and Proposed Decisions

2 November 2026. Evidence and proposals. Step B1 was approved and implemented on 2 November 2026 (see "B1 implementation" at the end). B2 to B5 have not been started.

## Source

| Item | Value |
| --- | --- |
| Document | *The Sphere Handbook: Humanitarian Charter and Minimum Standards in Humanitarian Response*, Fourth Edition, 2018 |
| Copy used | `https://www.sphereindia.org.in/sites/default/files/2022-07/Sphere-Handbook-2018-EN.pdf` (the link in the senior review) |
| Pages | 458; PDF created 10 October 2018 |
| SHA-256 | `eeb7e680c296e15389ca8a1e5882a3796f23cbba31cfb21dd4661332c4c8cf63` |
| Bibliographic | Sphere Association, Geneva, 2018. ISBN 978-1-908176-707 (PDF) |
| Edition status | According to Sphere's current published information, the 2018 edition remains the official reference and the fifth edition is expected in Q4 2028. Checked by the domain owner on 2 November 2026 against the [Handbook editions page](https://spherestandards.org/handbook/handbook-editions/) and the [revision FAQ](https://spherestandards.org/handbook-revision-2026-2028/faqs/). |
| Not verified | `spherestandards.org` refused automated access (HTTP 403). The SHA-256 above identifies the local copy only; it has not been compared with the PDF published by the Sphere Association, so it does not show the two files are identical. |

Page numbers below are the handbook's printed page numbers.

## Evidence for each figure ReliefGrid uses

| Code | ReliefGrid today | What the 2018 handbook says (quoted) | Reference | Verdict |
| --- | --- | --- | --- | --- |
| WATER | 15 L/person/day, fixed | Key indicator: "Minimum of 15 litres per person per day" and "Determine quantity based on context and phase of response". Guidance: "It is never a 'maximum' and may not suit all contexts or phases… In the acute phase of a drought, 7.5 litres per person per day may be appropriate for a short time. In an urban middle-income context, 50 litres per person per day may be the minimum acceptable amount". | WASH chapter, Water supply standard 2.1: Access and water quantity — key indicators p. 106; guidance p. 107 | **Verified**, but context-dependent; must be adjustable per camp |
| FOOD | 1 "ration"/person/day, described as 2,100 kcal | Key indicator: households that "receive the minimum food energy requirements (2,100kCal per person per day) and recommended daily micronutrient intake". Guidance: "2,100 kCal per person per day with 10–12 per cent of total energy provided by protein and 17 per cent provided by fat"; estimates "should be used for planning general rations and adjusted to context". | Food security and nutrition chapter, Food assistance standard 6.1: General nutrition requirements — key indicator p. 198; guidance p. 199 | 2,100 kcal **verified as a planning figure**. A generic "ration" unit is **not** a Sphere measure; the current model is unverified |
| SOAP | 8.333333 g/person/day | Key indicator: "250 grams of soap for bathing per person per month" | WASH chapter, Hygiene promotion standard 1.2: Identification, access to and use of hygiene items — key indicators p. 100 | **Verified** (monthly figure; ReliefGrid's daily value is a derived conversion) |
| LAUNDRY | 6.666667 g/person/day | Key indicator: "200 grams of soap for laundry per person per month" | same, p. 100 | **Verified** (as SOAP) |
| CONTAINER | 0.4 containers/person | Key indicator: "two water containers per household (10–20 litres; one for collection, one for storage)" | same, p. 100 | Two per **household** verified. **0.4 per person is ReliefGrid's derivation** from an assumed household of 5, which is not in this indicator |
| SHELTER | 3.5 m²/person | Key indicator: "Minimum 3.5 square metres of living space per person, excluding cooking space, bathing area and sanitation facility" and "4.5–5.5 square metres … in cold climates or urban settings where internal cooking space and bathing and/or sanitation facilities are included". Guidance: the minimum "should reflect cultural and social norms, the context, the phase of response…" | Shelter and settlement chapter, Shelter and settlement standard 3: Living space — key indicators p. 254; guidance p. 255 | **Verified**, with a definition (excludes cooking, bathing, sanitation) and a higher range for cold or urban settings |
| TOILET | 0.05/person (1 per 20), every toilet counts | Key indicator: "Ratio of shared toilets — Minimum 1 per 20 people"; "Distance between dwelling and shared toilet — Maximum 50 metres". Guidance: "During the first phases of a rapid-onset crisis, communal toilets are an immediate solution with a minimum ratio of 1 per 50 people… A medium-term minimum ratio is 1 per 20 people, with a ratio of 3:1 for female to male toilets." Accessible toilets "at a minimum ratio of 1 per 250 people". | WASH chapter, Excreta management standard 3.2: Access to and use of toilets — key indicators p. 116; guidance p. 117 (accessible 1 per 250) and p. 118 (1 per 50 first phase, 1 per 20 medium term, 3:1) | **Verified**; depends on response phase (1:50 first phase, 1:20 medium term); not every toilet is equivalent |
| TAP | 0.004/person (1 per 250) | Key indicator: "250 people per tap (based on a flow rate of 7.5 litres/minute)"; also 500 per hand pump (17 L/min), 400 per open hand well (12.5 L/min); nearest water point "<500 metres"; queuing "<30 minutes" | Water supply standard 2.1 — key indicators p. 106 | **Verified**, conditional on 7.5 L/min flow; a low-flow or broken tap is not a full tap |
| NET | 0.5/person (1 per 2) for every camp | Household items key indicator: "Long-lasting insecticide-treated nets **where needed**". Vector control guidance names bed nets among individual malaria protection measures. No ratio is given. | Shelter and settlement standard 4: Household items — key indicators p. 259; WASH Vector control standard 4.2 — guidance p. 125 | **Not a Sphere figure.** Sphere makes nets conditional and gives no per-person ratio. The 1-per-2 figure was attributed to WHO from memory and has **not** been verified |

Figures in ReliefGrid that are **not** from Sphere at all: the severity thresholds (2 and 5 days; 50 % and 90 %), the 7-day replenishment target, the household size of 5 behind containers, and the equal-weight "Sphere Compliance" score. One related Sphere reference: household items use "Per household or group of four to five individuals" for cooking sets (p. 259). That supports offering 5 as a labelled default, but not hiding it.

## Proposed decisions

Each item is my recommendation. Items marked **owner decision** need your (or a humanitarian adviser's) answer before they are built.

| # | Topic | Recommendation |
| --- | --- | --- |
| D1 | Terminology | Rename "Sphere Compliance" to **"Applicable indicators met"**. Add the disclaimer from the review to the methodology page and to the Command Center footer. Never use "Sphere compliant" or "certified". |
| D2 | Zero-person camps | Headcount 0 → state **Not assessed** (no severity). Excluded from the indicator score, crisis counts and KPI totals. Shown with a neutral "Not assessed" label. |
| D3 | Uncounted stock | `Stock.quantity` becomes empty (null) until the first count. State **Not counted**, distinct from a counted 0 (critical). Not-counted lines are excluded from the score and listed as needing a count. |
| D4 | Standard metadata | New fields on each standard: Sphere edition, standard number and title, indicator or guidance, printed page, **verification status** (*Verified* / *Derived from Sphere* / *Not a Sphere figure*), and how the per-person value was derived. The UI shows the status beside the figure. NET becomes *Not a Sphere figure*; CONTAINER, SOAP and LAUNDRY become *Derived*. |
| D5 | Applicability | Each standard is *Always applies* or *Applies where needed*. NET is *where needed* and counts only for camps where a coordinator switches it on, with a reason. Inactive standards are excluded from scores and requests. |
| D6 | Context targets | Per camp and standard, an optional local target that replaces the default, with reason, source, approver and effective date. Covers 15 L vs 7.5 or 50 L, and 3.5 vs 4.5–5.5 m². **Owner decision:** who may approve (proposed: role `Coordinator` records it, with the approver's name). |
| D7 | Households | Optional `households` on the camp. Containers = 2 × households. When households are not counted, use a configurable default household size (5) and mark the figure as **estimated**. **Owner decision:** default size. |
| D8 | Toilets and taps | Rename to **Functional toilets** and **Functional taps** (count only usable units), and show "people per functional toilet". Add a camp **response phase** (*First phase* → 1 per 50 people, *Medium term* → 1 per 20 people, both cited). Show the 7.5 L/min assumption on taps. Sex-separated, accessibility and lighting tracking is out of scope for this stage. |
| D9 | Planning settings | A single **Planning settings** record holding the 2 / 5-day and 50 / 90 % thresholds, the 7-day target and the default household size, each labelled "operational planning choice — not a Sphere standard". Severity and requests read from it. Defaults stay at today's values until you change them. |
| D10 | Food (**owner decision**) | **Option A (recommended for now):** keep counting ration packs, but each camp records the ration's energy value in kcal. Days of cover = (packs × kcal per pack) ÷ (people × 2,100), labelled "food energy planning". **Option B:** a commodity basket (kg of cereal, pulses, oil, with kcal per kg). More accurate and more work for field staff. Neither proves micronutrient adequacy; the UI will say so. |
| D11 | Hygiene items | Store and show soap as grams per person per month; the daily conversion stays internal. |
| D12 | Methodology page | A read-only page listing each standard, its value, unit, basis, applicability, verification status, quoted indicator, reference and page, plus the planning settings and the disclaimer. |

## Proposed implementation order (one step per approval)

| Step | Contents | Schema change | Migration | Tests |
| --- | --- | --- | --- | --- |
| B1 | D1, D4, D11, D12: citations, verification status, wording, disclaimer, methodology page | new columns on Standards only | reference data reloads on start; no business data touched | each standard has a status and page; no UI text claims compliance; methodology page renders |
| B2 | D2, D3: not assessed, not counted | `Stock.quantity` becomes nullable; severity gains state 0 | existing stock rows with no count become null (real database: 0 rows today) | empty camp is not assessed; new camp is "not counted", not critical; counted zero is critical; score excludes both |
| B3 | D9: planning settings | new `PlanningSettings` singleton; severity reads it | defaults equal today's values, so results are unchanged | changing a threshold changes severity; defaults reproduce current results |
| B4 | D5, D6, D7, D8: applicability, local targets, households, response phase | new `CampStandards` (per-camp applicability and target), `Camps.households`, `Camps.responsePhase` | all existing camps get defaults (always-applies on, nets off) | nets excluded unless switched on; containers from households; estimate flag; first-phase toilet target |
| B5 | D10: food model | depends on the decision | — | — |

Before each step: stop any process using `reliefgrid.sqlite` (`lsof -nP -iTCP -sTCP:LISTEN`), and run all tests on in-memory databases only. Each step ends with the full test suite, the browser tests and the production build.

## Questions for you

1. Approve D1–D12 as proposed, or change any?
2. Food: Option A or B?
3. Default household size when households are not counted: 5?
4. Should mosquito nets be off by default and switched on per camp?
5. Who may approve a local target, and must the approver be someone other than the person recording it?
6. Should I start with step B1 only?

## B1 implementation (2 November 2026)

Scope approved: D1 terminology and disclaimer, D12 methodology page, and corrected citations. The D4 standard metadata (verification status, page and so on) is held in a versioned file instead of new database columns, so B1 needed **no schema change and no migration** (`cds compile --to sql` output identical before and after).

| Item | Where |
| --- | --- |
| "Sphere Compliance" renamed **Applicable Indicators Met**; "Sphere Standard", "Sphere Minimum", "Sphere heatmap", "Stock & Sphere Gaps" renamed to indicator / reference requirement wording | `_i18n/i18n.properties`, `_i18n/messages.properties`, app i18n files, `app/index.html` |
| Disclaimer: decision support, not an official Sphere assessment, not endorsed, no certification; context and applicability change interpretation | Methodology page header; Command Center footer with a link to the page; README |
| Methodology and References app (`ReliefMethodology-display`): every indicator with Sphere 2018 reference, unit, chapter, standard, printed page, short quotation, verification status, qualifications, ReliefGrid calculation value and whether that value is a Sphere reference, a conversion or a planning assumption; planning choices; interpretation limits; source, checksum and edition status | `app/methodology/webapp/` (content in `model/methodology.json`) |
| Corrected citations, values unchanged: every reference now names standard and printed page; NET says "Not a Sphere figure" (no WHO attribution); CONTAINER and FOOD name the ReliefGrid planning assumption; FOOD description says a ration pack is assumed to provide 2,100 kcal | `db/data/reliefgrid-Standards.csv` (reference and FOOD descr columns only) |
| Priority "High" description no longer says "Sphere minimum" | `db/data/reliefgrid-Priorities.csv` |

Classification shown on the page:

| Code | Sphere reference status | ReliefGrid calculation value is |
| --- | --- | --- |
| WATER | Verified with conditions | Sphere reference |
| FOOD | Verified with conditions (planning figure) | ReliefGrid planning assumption (ration pack = 2,100 kcal) |
| SOAP, LAUNDRY | Verified (monthly) | Converted from Sphere (÷ 30 days) |
| SHELTER | Verified with conditions | Sphere reference |
| TOILET | Verified with conditions (phase) | Sphere reference (medium-term figure) |
| TAP | Verified with conditions (7.5 L/min) | Sphere reference |
| CONTAINER | Verified (per household) | ReliefGrid planning assumption (5 per household) |
| NET | Not a Sphere figure | ReliefGrid planning assumption |

Reference data is reloaded from `db/data` on every start of a file-database server. The real `reliefgrid.sqlite` still holds the old citation texts until the development server is next started deliberately; no business rows are affected.

Tests: `test/methodology.test.js` keeps the page in step with the CSV (codes, values, units), checks each review finding is represented, and fails if any source file claims Sphere compliance or certification. The browser test opens the page at 1440 and 390 px, checks the content, that every status label has text, keyboard Enter navigation from the summary table, the Command Center link and the launchpad intent.

## B1 follow-up: reference data consistency (2 November 2026)

**Who reads the Standards table.** ReliefService and DonorService both expose `Standards` (all columns, read-only) and `Priorities`. On screen, only `code`, `name`, `unit`, `basis`, `sortOrder` and the sector name are bound: Command Center heatmap headers and tooltips, gap list, transit list and delivery dialog; Manage Camps stock, requests and the Request Supplies value help (code and name only); Pledge Board item, sector and unit. No view, controller or annotation binds `descr` or `reference` (checked in both services' compiled `$metadata`), and `name`, `unit` and the values did not change. The methodology page reads its own file, not the database. Business logic reads only `code`, `basis` and `perPerson`.

**Where old wording can still exist.** Only at rest, in `descr` and `reference` (and the "High" priority description) of a file database last started before B1, which is the real `reliefgrid.sqlite`. It can be read through the raw OData API (`/Standards`, `/Priorities`, or an `$expand` of `standard` or `priority`) only by a server that did not refresh first, and no server in this project does that: see below.

**How corrected reference data reaches an existing database.**
- File SQLite (development, Docker self-host): in `server.js`, the `served` handler runs `cds.deploy(...)` with schema evolution and then `cds.deploy.data(...)`. With schema evolution, CAP loads the CSV files as `UPSERT` keyed on `code`, which overwrites the CSV's columns for matching rows and adds missing rows. No other table is written. CAP's own data load already runs on every start, because its schema step always reports work; the explicit `deploy.data` call is a second, harmless upsert that keeps the refresh independent of that detail. CAP waits for the `served` handlers before calling `listen`, so no request is answered before the refresh.
- In-memory (tests, preview): created from the CSV on every start.
- SAP HANA (production build): `cds build` puts the corrected CSV into `gen/db/src/gen/data` with `.hdbtabledata`, which the HDI deployer applies on each deployment. Not run, because no HANA deployment exists yet.

**Verification on isolated databases** (temporary files; the real file only read with `cp`):
- Fresh database: both services return the corrected name, description, unit, value and citation for all 9 indicators and the corrected priority text; no old wording in any response.
- Byte-identical copy of the real database: before start it holds the WHO citation; after one start both services return the corrected text. Schema is unchanged, values, units and basis are unchanged, and the business tables are still empty, as in the original.
- Existing database with synthetic camps, stock counts, requests, pledges, a delivery and an open edit draft, with the old wording written back into its reference tables: after one start the corrected text is served, and all 27 other tables are identical row for row (`cds_model` is covered below). The overview KPIs, camp health, requirements, cover and severity are identical.
- `cds_model` is CAP's stored copy of the deployed model. It is rewritten on every start and alternates between two equivalent forms (an internal `@cds.persistence.skip` flag). This predates B1, changes no schema or data, and was left as is.
- New regression test `test/reference-data.test.js` repeats the existing-database case on a temporary file and fails if the start-up refresh is removed (checked by temporarily changing `server.js` to deploy the schema only).

No feature depends on the old wording: no code, test or annotation reads `descr` or `reference`, and the browser test now fails if any page shows superseded wording.

**The real database** still holds the old texts at rest. They are replaced the next time someone deliberately starts the development server against it, with no change to business data. Nothing was started against it in this check.

## B2 implementation (3 November 2026)

Scope approved: D2 (Not assessed) and D3 (Not counted). B3 to B5 not started.

**Model change (smallest correct one).**
- Count state comes from the existing `Stock.countedAt`, which only `recordCount` sets. No new column.
- `Stock.quantity` and `Camps.headcount` lose `default 0`; new stock lines are inserted with `quantity = null`, and a new camp draft gets `headcount = null` explicitly. Explicit values matter because CAP's SQLite schema evolution does not change column defaults, so existing databases keep `DEFAULT 0` in their DDL.
- New calculated elements: `Stock.assessment` (`NOT_ASSESSED`, `NOT_COUNTED`, `CRITICAL`, `ATTENTION`, `MET`) and `Stock.status` (its label). `required`, `daysOfCover`, `coveragePct`, `shortfall` and `severity` are empty unless the line is assessed and counted. `CampHealth` adds `metIndicators`, `assessedIndicators`, `notCountedIndicators`, `assessment` and `nothingAssessed`; `compliance` = met / assessed, empty when nothing is assessed. `overview()` adds `campsNotAssessed` and `indicatorsNotCounted`.
- `NOT_APPLICABLE` is reserved for B4 and never produced.

**Data migration (file SQLite, on start, idempotent).** `quantity = 0 AND countedAt IS NULL` → `quantity = NULL`, keeping `modifiedAt` and `modifiedBy`. Those zeros can only be the old default, so no observation is lost. Not changed: counted zeros, counted quantities, quantities received onto never-counted lines (kept, shown as Not counted), camp headcounts (0 and empty both mean Not assessed, so no rewrite is needed). The real `reliefgrid.sqlite` has no stock rows, so the migration is a no-op there. SAP HANA has no installation yet; the same statement would be needed before a HANA database with pre-B2 data is upgraded.

**Behaviour changes to note.**
- *Raise requests* skips not-counted lines and says so (`LINES_NOT_COUNTED`), and refuses camps that are not assessed (`CAMP_NOT_ASSESSED`). Follow-up check (3 Nov 2026): skipped lines are a **warning**, so Manage Camps shows a partial result in a *Warning* dialog ("Supply requests raised …: n." plus "Skipped: n indicators never counted, so no confirmed shortage can be calculated. Record stock counts first, then raise again."); when nothing was raised because of uncounted stock it says "No supply requests were raised." The Command Center shows the same as a "Requests partly raised" / "No requests raised" warning instead of a success toast. Its Raise Requests button had never worked (it read the camp with `getProperty` on a navigation object) and now does. Failures show an error dialog only. Final check (3 Nov 2026): the action now returns `RaiseResult { created, skipped, notAssessed }`, counted during that operation; the Command Center builds its message from this result only (no separate camp lookup), and Manage Camps shows the server messages of the same operation. A browser test holds the action response while the camp changes and requires the operation's own counts to be shown. Before, never-counted lines were requested in full as if stock were zero. Manual *Request supplies* is unchanged.
- A delivery confirmed onto a never-counted line no longer makes up a quantity (before: default 0 + received). The receipt stays on the pledge; the next count sets the stock.

**Verification.** Permanent tests in `test/assessment.test.js` (zero and missing population, not counted, counted zero, counted positive, exclusion from the score, days of cover, request generation, delivery onto an uncounted line, overview / camp health / stock consistency, donor board), `test/migration.test.js` (existing database: only never-counted zeros change, audit fields kept, other tables identical, idempotent), plus QUnit and browser checks for the heatmap, KPIs, Manage Camps and Pledge Board. A database built with the pre-B2 code was migrated on a copy: 28 never-counted zeros emptied, the other 17 stock rows and all 28 other tables identical, the fully counted camp's figures unchanged, the zero-population and no-headcount camps changed from 100 % to Not assessed.

## B3 implementation (4 November 2026)

Scope approved: D9 planning settings, with the owner's final decisions (Administrator-only changes with a reason and audit, immediate effect, defaults unchanged, strict comparisons, no stale-count threshold, household size stays in B4). B4 and B5 not started.

**Approach validated first.** Every stock line joins the single record through an unmanaged association (`settings.ID = 'CURRENT'`, no column). Runtime-validated on SQLite (in-memory and temporary files). For SAP HANA only compilation and the `cds build --production` artefacts were checked (`PlanningSettings.hdbtable`, views joining `ON settings.ID = 'CURRENT'`); no HANA runtime was available, so HANA behaviour is **not** validated.

Two risks found while validating, and handled:
- Shipping the defaults as CSV would let the start-up reference-data refresh overwrite an administrator's change on every restart. The record is therefore created in code only when it is missing, and never overwritten.
- Without the record every threshold comparison is null and a line would fall through to "met". The calculation now treats a missing record as Not assessed, so nothing is ever met without thresholds; raising requests then fails with an explicit error.

**Model.** `PlanningSettings` (one record: `criticalDays`, `warningDays`, `criticalPercent`, `warningPercent`, `targetDays`, plus managed fields) and the append-only `PlanningSettingsChanges` (changedAt, changedBy, reason, previous and new value of each field). Stock and Camps gain an unmanaged `settings` association (no column). The threshold literals in `Stock.assessment` and the 7 in `Stock.shortfall` now read the record; comparisons stay strict and critical is tested first.

**Service.** `ReliefService.PlanningSettings` is read-only; the bound action `change(5 values, reason)` requires `Administrator`. Validation: every value positive; critical strictly below warning (days and percent); warning percent at most 100; warning days and target at most 90; target an integer; a reason; refuses a save that changes nothing. A target below the warning threshold is saved with a warning (owner decision). The change runs in one transaction (record locked, log written) and returns how many indicator lines in how many active camps changed state. `planningAccess()` tells the UI whether to offer the change. *Raise Requests* uses the stored target when none is given; the Manage Camps dialog starts at it.

**Views.** Command Center legend, shortfall column and empty-gaps text read the record. The methodology page shows the values in force, who changed them last and why, and the change history; administrators get a change dialog that states the impact before saving and reports it after. Donors see no threshold values ("visible to coordinators") rather than possibly outdated defaults.

**Migration.** New tables only; the record is created with the defaults on the next start. Verified on copies of a B2-era database, a pre-B2 database and the real database: every stock line keeps its exact pre-B3 state (checked against an independent recalculation), all existing tables are unchanged apart from the earlier, approved B1/B2 migrations, and the change history starts empty.

**Not in B3.** No stale-count threshold (freshness policy is a separate domain decision; an old count is never treated as uncounted). Household size stays with B4.

**B3 security verification (4 Nov 2026).** Added: a `version` on the settings record and a mandatory `version` parameter on the change action (a stale or concurrent change is refused instead of silently overwriting another); retrying creation of the record when several processes start together; an unassigned Planning Administrator role collection in `mta.yaml`. Verified: role enforcement on every route to the action, immutability of the change history, settings change and audit entry in one transaction (an injected audit failure rolls the settings back), one record only, and that Command Center, Manage Camps and the default replenishment target follow a change at once. Details in SECURITY_AUDIT "B3 security verification".

**B3 closed (4 Nov 2026)**, approved by the domain owner. Hardening completed afterwards: test users and passwords removed from `package.json` and every build artefact (now in `test/helpers/test-users.js`, enforced by a build test); the classification display mapping documented in FIORI_UX_REVIEW. B4 is proposed in STAGE_B4_PROPOSAL and not implemented.

## B5 implementation (11 November 2026)

Owner decision D10: **Option A**. Food is counted in ration packs, against food energy.

**Rule.** Each camp may record the energy of its ration pack (`Camps.rationKcalPerPack`, a whole number of kcal, at least 1). The daily requirement in packs is people × 2,100 kcal ÷ kcal per pack, so days of cover = (packs × kcal per pack) ÷ (people × 2,100). Until a camp records its pack, 2,100 kcal per pack is assumed (the earlier ReliefGrid planning assumption, so existing camps keep their figures) and the line says "Food energy (assumed kcal)"; with a recorded value it says "Food energy (recorded kcal)". The methodology page states that energy alone does not show protein, fat or micronutrient adequacy.

**Precedence.** B4.1 applicability first; an approved B4.2 local target (in packs per person per day) replaces the energy figure, which stays visible as the reference.

**History and requests.** Assessment records keep the kcal per pack and whether it was recorded or assumed; lines keep kcal per person per day and per unit; request bases name them. Recording or correcting the energy of a pack writes a "Ration energy changed" assessment and flags each outstanding food request whose requirement changed, with the figures before and after, following the principle the owner ruled for household figures; quantities, pledges and deliveries are never changed.

**Verification.** `test/food-energy.test.js` (12); mutation checks 5 of 5; upgrade from the accepted B4.3 release kept every food requirement unchanged.
