# Domain and Sphere Review

Stage A, 2 November 2026. This file records what the current implementation does. Checking each figure against the Sphere Handbook 2018 text is Stage B; until then every citation below is **unverified**.

## Standards as implemented (`db/data/reliefgrid-Standards.csv`)

| Code | Value used | How it is modelled today | Review concern | Severity |
| --- | --- | --- | --- | --- |
| WATER | 15 L/person/day | fixed, consumption | context and phase adaptation not recordable | P1 |
| FOOD | 1 "ration"/person/day, described as 2,100 kcal | generic unit "rations" | a ration count does not prove energy or nutrient adequacy | P1 |
| SOAP | 8.333333 g/person/day | daily conversion of 250 g/month | monthly basis hidden; product form undefined | P2 |
| LAUNDRY | 6.666667 g/person/day | daily conversion of 200 g/month | as SOAP | P2 |
| SHELTER | 3.5 m²/person | coverage | what is measured (covered living space) not defined; context targets | P2 |
| TOILET | 0.05 toilets/person (1:20) | coverage, every toilet counts | functional, shared, sex-separated, accessible not tracked | P1 |
| TAP | 0.004 taps/person (1:250) | coverage, every tap counts | 7.5 L/min flow assumption invisible; broken or low-flow taps count fully | P1 |
| CONTAINER | 0.4 containers/person | coverage | hidden assumption of 5 people per household | P1 |
| NET | 0.5 nets/person | coverage, applies to every camp | not universal; depends on malaria risk and programme | P1 |

## Findings

### DOM-01 · P0 · Confirmed — citations were written from memory
- **Update 2 Nov 2026:** every figure has now been checked against the 2018 handbook text, with quotes and printed page numbers, in STAGE_B_DOMAIN_DECISIONS.md. Seven are verified, some only with context. Containers per person is a ReliefGrid derivation. The mosquito-net ratio is not a Sphere figure.
- **Resolved in B1 (2 Nov 2026):** citations in the CSV corrected (standard and printed page; NET marked "Not a Sphere figure"); full evidence shown on the Methodology and References page.
- **Evidence:** the `reference` column of the CSV. The README and UI present them as Sphere references.
- **Change (Stage B):** check each against the 2018 handbook (edition, chapter, standard, indicator or guidance note, page). Any figure that cannot be verified gets flagged in the data, not re-cited.

### DOM-02 · P0 · Confirmed — "Sphere Compliance" implies certification and counts every indicator equally
- **Evidence:** `_i18n/i18n.properties:30` `Compliance=Sphere Compliance`; `db/schema.cds:182-190` divides adequate stock lines by all stock lines, so mosquito nets count everywhere and a critical water gap weighs the same as a container shortfall.
- **Change:** rename to "Applicable indicators met"; exclude not-applicable indicators from the denominator; always show critical gaps beside it; add a disclaimer and a methodology page.
- **Partly resolved in B1:** renamed, disclaimer and methodology page added. Applicability (excluding indicators from the denominator) is B4.

### DOM-03 · P1 · Confirmed — an empty camp shows 100 % compliance
- **Evidence:** severity is 3 when headcount is 0 (`db/schema.cds`, severity expression), so CampHealth reports 100 %. The Command Center hides this (heatmap shows 0 %), but the Manage Camps list does not.
- **Change:** headcount 0 → "not assessed", excluded from the score.
- **Resolved in B2 (3 Nov 2026):** empty or 0 population → every line *Not assessed* (no requirement, cover, shortfall or severity); camp health has no percentage; no requests raised. See STAGE_B_DOMAIN_DECISIONS "B2 implementation".

### DOM-04 · P1 · Confirmed — "not counted" looks the same as "counted zero"
- **Evidence:** `Stock.quantity default 0` (`db/schema.cds:104`); a new camp's lines are critical immediately, and `countedAt` is not used in severity.
- **Change:** quantity null until first count, a "not assessed" state, and stale-count warnings based on `countedAt` (thresholds are operational settings, not Sphere rules).
- **Resolved in B2 (3 Nov 2026), except stale-count warnings:** quantity is empty until the first count; never-counted lines are *Not counted*, excluded from the score and from requests; a counted 0 is critical. Stale-count warnings need a threshold and belong with the planning settings (B3).

### DOM-05 · P1 · Confirmed — household-based and context-based standards have no inputs
- **Evidence:** Camps has headcount and children under 5 only (`db/schema.cds:77-93`).
- **Change (proposal for Stage B):** household count on the camp (containers from households; estimated when missing, marked as estimate); an applicability flag per camp and standard (nets, and any local override); a per-standard local target with source, reason, approver and effective date.

### DOM-06 · P1 · Confirmed — functional infrastructure not distinguished
- **Evidence:** toilets and taps are plain counts.
- **Change (proposal):** count functional units only, with notes; show "people per functional toilet" and the assumed tap flow rate.

### DOM-07 · P1 · Confirmed — food modelled as generic rations
- **Change (proposal):** rename to "Food energy planning (kcal/person/day)" and record stock in kcal, or model a defined ration basket. Needs an owner decision.

### DOM-08 · P2 · Confirmed — monthly hygiene quantities shown as daily grams
- **Change:** store and show the monthly figure; keep the daily conversion internal.
- **Partly resolved in B1:** the methodology page shows the monthly Sphere figure and labels the daily value as a conversion. The stored value is still daily.

### DOM-09 · P1 · Confirmed — operational settings look like Sphere rules
- **Evidence:** 2 / 5-day and 50 / 90 % thresholds and the 7-day target are fixed in code (ARCH-07) and shown next to Sphere figures.
- **Change:** configurable settings labelled as operational planning choices.
- **Partly resolved in B1:** labelled as ReliefGrid planning choices on the methodology page and the Command Center legend. Making them configurable is B3.
- **Resolved in B3 (4 Nov 2026):** one planning-settings record (defaults 2 / 5 days, 50 / 90 %, 7 days) read by every calculation; changed only by Administrators, with a reason and a full audit log. See STAGE_B_DOMAIN_DECISIONS "B3 implementation".

## Decisions needed from a domain owner
1. Food: kcal-based stock or a defined ration basket?
2. Default household size when households are not counted (currently a hidden 5).
3. Which standards are on by default, and which (nets) need explicit activation?
4. Who may approve a local target override?
5. Thresholds and replenishment target (currently 2 / 5 days, 50 / 90 %, 7 days).
