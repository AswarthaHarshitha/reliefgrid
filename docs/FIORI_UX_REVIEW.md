# Fiori UX Review

Stage A, 2 November 2026. Based on the running apps (screenshots at 1440 px and 390 px from the browser test run) and the view, controller and annotation files.

## Keep
- List report and object page floorplans for Manage Relief Camps and Pledge Board, driven by annotations.
- Semantic criticality colours, illustrated empty states, column importance, action availability rules.
- Command Center on the same Horizon theme parameters (`css/style.css` uses theme variables only).

## Findings

| ID | Sev | Status | Evidence | Problem | Change |
| --- | --- | --- | --- | --- | --- |
| UX-01 | P1 | Confirmed | `srv/lib/supply.js:5` (OUTSTANDING includes PLEDGED); `i18n:21` | "Open Requests" counts fully pledged requests | split into "Requests awaiting pledge" and "Requests with incoming pledges" |
| UX-02 | P1 | Confirmed | `app/command/webapp/i18n/i18n.properties:17` | "Camps in Crisis" is not defined on screen | "Camps with critical gaps" + tooltip with the rule |
| UX-03 | P1 | Confirmed | `Main.controller.js` subtitle | "updated HH:MM" is refresh time only, with no time zone; stock count age is not shown on the heatmap | show data refresh time with zone and, per cell, the age of the last count; stale warning |
| UX-04 | P1 | Confirmed | heatmap cells (`Main.controller.js`, `_buildHeatmapColumns`) | severity is carried by colour; the text shows only the value ("0.5 d") | add a severity word or icon per cell and an accessible label |
| UX-05 | P1 | Confirmed | `onRaiseRequests`; FE action `raiseRequests` | requests are published without a preview | preview dialog with each line (need, target, on hand, incoming, request, priority, date) before publishing |
| UX-06 | P1 | Confirmed | `onConfirmDelivery` dialog; FE `confirmDelivery` | no condition, accepted quantity or discrepancy reason | rename to "Record received quantity" and add these fields (with ARCH-03) |
| UX-07 | P1 | Confirmed | Fiori elements Delete on camps | Delete destroys history (ARCH-04) | hide Delete for camps with history |
| UX-08 | P2 | Confirmed | no "needs attention" area | operators must scan the heatmap to find what to act on | an attention list above the heatmap: critical gaps by time to stock-out, overdue deliveries, unanswered requests, stale counts |
| UX-09 | P2 | Confirmed | heatmap columns in CSV order | standards not grouped by sector | group headers by sector; filters for region, district, hazard, severity |
| UX-10 | P2 | Confirmed | KPI tiles | formulas are not discoverable | tooltip with the exact rule on each tile |
| UX-11 | P2 | Confirmed | Pledge dialog (FE action parameters) | the dialog does not repeat the unit, still-needed quantity, destination or that a pledge is not a delivery | parameter descriptions and a short help text |
| UX-12 | P2 | Confirmed | `Main.controller.js:65` | over 1,000 camps truncated silently (ARCH-09) | paging or notice |
| UX-13 | P2 | Confirmed | microcopy | "Record Count", "Confirm Delivery", "Raise Requests from Gaps", "On Hand", "Cover" | the review's wording: "Record stock count", "Record received quantity", "Review and publish replenishment requests", "Usable stock on hand", "Estimated days of cover" / "Coverage" |
| UX-14 | P1 | Confirmed (found during SEC-02 verification) | `srv/donor-service.cds` Pledges has no filter; Requests hides cancelled requests and closed camps | after a camp closes, donors still list its pledges while the request expands to nothing | business-rule decision first (what donors see for pledges on closed camps or cancelled requests, and how they are told); do not patch with a bare filter |

## Classification display mapping (confirmed 4 Nov 2026)

One classification (`Stock.assessment`, with `severity` 1 / 2 / 3 or empty) drives every view. The colour names below are SAP's internal names; users only see ReliefGrid's words and the colour.

| Classification | severity | Command Center heatmap (UI5 value state) | Manage Camps (Fiori criticality) | Word shown |
| --- | --- | --- | --- | --- |
| CRITICAL | 1 | `Error` (red) | 1 = Negative (red) | Critical |
| ATTENTION | 2 | `Warning` (orange) | 2 = "Critical" in UI5 terms (orange) | Needs attention |
| MET | 3 | `Success` (green) | 3 = Positive (green) | Met |
| NOT_COUNTED, NOT_ASSESSED | empty | `None` (neutral) | 0 = Neutral | Not counted, Not assessed |

Note the naming trap: UI5 calls orange "Critical", which is ReliefGrid's *Needs attention*. Never surface SAP's colour names in ReliefGrid texts. Mapping code: `app/command/webapp/model/formatter.js` (`STATE`, `COLOR`), `app/camps/annotations.cds` (`Criticality: severity`), labels in `db/schema.cds` (`Stock.status`). Tests: Command Center QUnit (`severityState`), `test/assessment.test.js` (label and severity per state), browser test "Command Center heatmap shows the new state for that line" and "Manage Camps shows the same state".

Still open (UX-04): heatmap cells carry the classification by colour and the legend; the cell itself shows only the value ("2.5 d"). Adding the word per cell, or to its tooltip and accessible label, belongs to Stage E.

## Not yet tested
- Keyboard-only use of every workflow, screen reader output, focus order, 200 % zoom, contrast.
- Widths 320, 360, 768 and 1024 px (only 390 and 1440 px tested).
- Slow and intermittent networks, long names and non-Latin text.

## Status (11 November 2026)

| ID | Status |
| --- | --- |
| UX-01 | Done: Requests Awaiting Pledge and Requests with Incoming Pledges |
| UX-02 | Done: Camps with Critical Gaps, with the rule in the tooltip |
| UX-03 | Done: refresh time with the browser's time zone; each cell's tooltip has the count date. No stale warning: there is no stale-count threshold (B3 decision) |
| UX-04 | Done: icon and severity word per cell, also announced to screen readers |
| UX-05 | Done: Review and Publish Requests preview (shared module used by the Command Center and Manage Relief Camps), with skipped lines explained |
| UX-06 | Done: Record Received Quantity with accepted quantity, condition, reason and closing the pledge |
| UX-07 | Done: Delete hidden for camps with history |
| UX-08 | Done: Act Now list (critical gaps by time to stock-out, overdue deliveries, unanswered requests); stale counts excluded (no threshold) |
| UX-09 | Done: columns grouped by sector; filters for region, district, hazard and worst state |
| UX-10 | Done: every KPI tile states its rule, with the thresholds in force |
| UX-11 | Done: the pledge quantity starts at what is still needed; labels and quick info explain the unit and that a pledge is not a delivery |
| UX-12 | Done with ARCH-09 |
| UX-13 | Done: Record Stock Count, Record Received Quantity, Review and Publish Requests, Usable Stock on Hand, Estimated Days of Cover or Coverage (short forms in narrow columns) |
| UX-14 | Done (owner ruling): donors see their pledges with "Camp closed" or "Request cancelled", and a My Pledges tab |

