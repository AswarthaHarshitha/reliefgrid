sap.ui.define(["./formatter"], function (formatter) {
  "use strict";

  var DEFAULT_TEXTS = {
    notAssessed: "Not assessed",
    notCounted: "Not counted",
    notDecided: "Not decided",
    notApplicable: "Not applicable",
    noRequirement: "No requirement",
    notDecidedHint: "applicability not decided for this camp",
    notApplicableHint: "an approved decision says it does not apply",
    noRequirementHint: "applies, but no approved requirement",
    noPopulation: "no population recorded",
    localTarget: "local target {0} per person (reference {1})",
    counted: "counted {0}",
    noLine: "no stock line",
    notVerified: "Not confirmed",
    notVerifiedHint: "functionality not confirmed; {0} units recorded in total",
    unconfirmed: "functionality not confirmed",
    severity1: "Critical",
    severity2: "Needs attention",
    severity3: "Met"
  };

  /** UX-04: the severity is never carried by colour alone: an icon and a word go with it. */
  var SEVERITY_ICON = { 1: "sap-icon://error", 2: "sap-icon://alert", 3: "sap-icon://sys-enter-2" };

  var UNESTABLISHED = { NOT_DECIDED: "notDecided", NOT_APPLICABLE: "notApplicable", NO_REQUIREMENT: "noRequirement" };

  /** Lower ranks come first: critical, needs attention, nothing counted, met, not assessed. */
  function rank(row) {
    if (row.state === "notAssessed") {
      return 5;
    }
    if (row.worstSeverity === 1 || row.worstSeverity === 2) {
      return row.worstSeverity;
    }
    return row.state === "notCounted" ? 3 : 4;
  }

  /**
   * Turns camps (with their stock and health expanded) into heatmap rows,
   * one cell per reference indicator, ordered so the camps in the worst state
   * come first. A camp without people recorded is not assessed, and a line
   * that was never counted is shown as such; neither is ever shown as met.
   */
  function build(camps, standards, texts) {
    var t = Object.assign({}, DEFAULT_TEXTS, texts);

    var rows = camps.map(function (camp) {
      var byStandard = {};
      (camp.stock || []).forEach(function (s) {
        byStandard[s.standard_code] = s;
      });
      var assessed = camp.headcount > 0;

      var cells = {};
      standards.forEach(function (standard) {
        var s = byStandard[standard.code];
        var cell = { severity: 0, state: "None", text: "–", icon: "", word: "", tooltip: standard.name + ": " };
        if (!assessed) {
          cell.tooltip += t.notAssessed + ", " + t.noPopulation;
        } else if (!s) {
          cell.tooltip += t.noLine;
        } else if (UNESTABLISHED[s.assessment]) {
          // established neither as a need nor as a gap: a word, no colour, never a shortage
          cell.text = t[UNESTABLISHED[s.assessment]];
          cell.tooltip += t[UNESTABLISHED[s.assessment]] + ", " + t[UNESTABLISHED[s.assessment] + "Hint"];
        } else if (s.assessment === "NOT_VERIFIED") {
          // B4.5: a total alone neither meets the requirement nor shows a gap
          cell.text = t.notVerified;
          cell.tooltip += t.notVerifiedHint.replace("{0}", formatter.decimal(s.quantity));
        } else if (s.assessment === "NOT_COUNTED" || s.severity === null || s.severity === undefined) {
          cell.text = t.notCounted;
          cell.tooltip += t.notCounted;
        } else {
          cell.severity = s.severity;
          cell.state = formatter.severityState(s.severity);
          cell.text = formatter.coverText(standard.basis, s.daysOfCover, s.coveragePct);
          cell.icon = SEVERITY_ICON[s.severity] || "";
          cell.word = t["severity" + s.severity] || "";
          cell.tooltip += cell.word + ", " + formatter.decimal(s.quantity) + " / " + formatter.decimal(s.required) + " " + standard.unit +
            (s.countedAt ? " · " + t.counted.replace("{0}", formatter.dateTime(s.countedAt)) : "");
        }
        // calculated with a local target instead of the reference figure (B4.2): marked, never coloured differently
        if (s && s.targetBasis === "LOCAL_TARGET") {
          cell.localTarget = true;
          cell.text += " *";
          cell.tooltip += " · " + t.localTarget.replace("{0}", formatter.decimal(Number(s.perPerson))).replace("{1}", formatter.decimal(Number(s.referencePerPerson)));
        }
        // worked out from households (B4.3): recorded or estimated, always said which
        // a critical toilet or tap line from its total only: functional units can only be fewer (B4.5)
        if (s && s.severity === 1 && s.functionalityText === "Not confirmed") {
          cell.tooltip += " · " + t.unconfirmed;
        }
        // or from the first-phase figure for toilets (B4.4)
        if (s && (s.targetBasis === "HOUSEHOLD" || s.targetBasis === "PHASE_FIGURE" || s.targetBasis === "FOOD_ENERGY") && s.targetBasisText) {
          cell.tooltip += " · " + s.targetBasisText;
        }
        cells[standard.code] = cell;
      });

      var health = camp.health || {};
      var state = !assessed ? "notAssessed" : (health.assessedIndicators ? "assessed" : "notCounted");
      var row = {
        ID: camp.ID,
        name: camp.name,
        // UX-09: what the heatmap can be filtered by
        region: camp.region || "",
        district: camp.district || "",
        hazard: camp.hazard ? camp.hazard.name : "",
        place: [camp.district, camp.region].filter(Boolean).join(", ") + (camp.hazard ? " · " + camp.hazard.name : ""),
        headcount: camp.headcount === undefined ? null : camp.headcount,
        childrenUnder5: camp.childrenUnder5 || 0,
        state: state,
        stateText: state === "notAssessed" ? t.notAssessed : (state === "notCounted" ? t.notCounted : ""),
        compliance: state === "assessed" ? health.compliance : null,
        worstSeverity: state === "assessed" ? health.worstSeverity || 0 : 0,
        criticalGaps: state === "assessed" ? health.criticalGaps || 0 : 0,
        notCounted: assessed ? health.notCountedIndicators || 0 : 0,
        cells: cells
      };
      row.rank = rank(row);
      return row;
    });

    rows.sort(function (a, b) {
      return a.rank - b.rank ||
        b.criticalGaps - a.criticalGaps ||
        (a.compliance || 0) - (b.compliance || 0) ||
        (b.headcount || 0) - (a.headcount || 0);
    });
    return rows;
  }

  return { build: build };
});
