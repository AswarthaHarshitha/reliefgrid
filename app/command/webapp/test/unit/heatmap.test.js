sap.ui.define(["reliefgrid/command/model/heatmap"], function (heatmap) {
  "use strict";

  var standards = [
    { code: "WATER", name: "Water", unit: "litres", basis: "Consumption" },
    { code: "TOILET", name: "Toilets", unit: "toilets", basis: "Coverage" }
  ];

  function camp(id, headcount, health, stock) {
    return {
      ID: id, name: "Camp " + id, district: "D", region: "R", headcount: headcount,
      hazard: { name: "Flood" }, health: health, stock: stock
    };
  }

  QUnit.module("heatmap");

  QUnit.test("builds one cell per standard", function (assert) {
    var rows = heatmap.build([
      camp("a", 100, { worstSeverity: 1, criticalGaps: 1, compliance: 50 }, [
        { standard_code: "WATER", quantity: "1500", required: "1500", daysOfCover: "1.0", severity: 1 },
        { standard_code: "TOILET", quantity: "5", required: "5", coveragePct: "100", severity: 3 }
      ])
    ], standards);

    assert.strictEqual(rows[0].place, "D, R \u00b7 Flood");
    assert.strictEqual(rows[0].cells.WATER.text, "1 d");
    assert.strictEqual(rows[0].cells.WATER.state, "Error");
    assert.strictEqual(rows[0].cells.TOILET.text, "100 %");
    assert.strictEqual(rows[0].cells.TOILET.state, "Success");
    // UX-04: the severity is never colour alone: a word in the tooltip and for screen readers, and an icon
    assert.strictEqual(rows[0].cells.WATER.tooltip, "Water: Critical, 1,500 / 1,500 litres");
    assert.strictEqual(rows[0].cells.WATER.word, "Critical");
    assert.strictEqual(rows[0].cells.WATER.icon, "sap-icon://error");
    assert.strictEqual(rows[0].cells.TOILET.word, "Met");
    assert.strictEqual(rows[0].cells.TOILET.icon, "sap-icon://sys-enter-2");
  });

  QUnit.test("puts the camps in the worst state first", function (assert) {
    var rows = heatmap.build([
      camp("fine", 500, { worstSeverity: 3, criticalGaps: 0, compliance: 100, assessedIndicators: 2 }, []),
      camp("warn", 900, { worstSeverity: 2, criticalGaps: 0, compliance: 50, assessedIndicators: 2 }, []),
      camp("crit-small", 50, { worstSeverity: 1, criticalGaps: 1, compliance: 50, assessedIndicators: 2 }, []),
      camp("crit-big", 800, { worstSeverity: 1, criticalGaps: 4, compliance: 0, assessedIndicators: 4 }, []),
      camp("uncounted", 300, { worstSeverity: null, compliance: null, assessedIndicators: 0, notCountedIndicators: 2 }, []),
      camp("empty", 0, null, [])
    ], standards);
    assert.deepEqual(rows.map(function (r) { return r.ID; }), ["crit-big", "crit-small", "warn", "uncounted", "fine", "empty"],
      "a camp with nothing counted ranks above camps that meet the reference");
  });

  QUnit.test("shows camps without people as not assessed, never as met", function (assert) {
    [0, null].forEach(function (headcount) {
      var rows = heatmap.build([camp("e", headcount, { worstSeverity: null, compliance: null, assessedIndicators: 0 }, [
        { standard_code: "WATER", quantity: "500", required: null, severity: null, assessment: "NOT_ASSESSED" }
      ])], standards);
      assert.strictEqual(rows[0].state, "notAssessed");
      assert.strictEqual(rows[0].stateText, "Not assessed");
      assert.strictEqual(rows[0].compliance, null);
      assert.strictEqual(rows[0].headcount, headcount, "population is not turned into 0");
      assert.strictEqual(rows[0].cells.WATER.text, "–");
      assert.strictEqual(rows[0].cells.WATER.state, "None");
      assert.strictEqual(rows[0].cells.WATER.tooltip, "Water: Not assessed, no population recorded");
    });
  });

  QUnit.test("shows never-counted lines as not counted, not as zero", function (assert) {
    var rows = heatmap.build([camp("n", 100, { worstSeverity: 1, criticalGaps: 1, compliance: 0, assessedIndicators: 1, notCountedIndicators: 1 }, [
      { standard_code: "WATER", quantity: "0", required: "1500", daysOfCover: "0", severity: 1, assessment: "CRITICAL", countedAt: "2026-11-02T08:00:00Z" },
      { standard_code: "TOILET", quantity: null, required: "5", severity: null, assessment: "NOT_COUNTED" }
    ])], standards);
    assert.strictEqual(rows[0].state, "assessed");
    assert.strictEqual(rows[0].notCounted, 1);
    assert.strictEqual(rows[0].cells.TOILET.text, "Not counted");
    assert.strictEqual(rows[0].cells.TOILET.state, "None");
    assert.strictEqual(rows[0].cells.WATER.text, "0 d", "a counted zero is shown as zero");
    assert.strictEqual(rows[0].cells.WATER.state, "Error");
    assert.ok(rows[0].cells.WATER.tooltip.indexOf("counted ") > 0, "the count time is in the tooltip");
  });

  QUnit.test("shows unconfirmed toilets as a word without a colour, and a certain crisis as critical", function (assert) {
    var rows = heatmap.build([camp("f", 100, { worstSeverity: 1, compliance: 0, assessedIndicators: 1, notCountedIndicators: 0 }, [
      { standard_code: "TOILET", quantity: "4", required: "5", severity: null, assessment: "NOT_VERIFIED", functionalityText: "Not confirmed" },
      { standard_code: "WATER", quantity: "100", required: "1500", daysOfCover: "0.1", severity: 1, assessment: "CRITICAL" }
    ])], standards);
    var toilet = rows[0].cells.TOILET;
    assert.strictEqual(toilet.text, "Not confirmed");
    assert.strictEqual(toilet.state, "None", "no colour: neither met nor a gap");
    assert.ok(toilet.tooltip.indexOf("4 units recorded in total") > 0, toilet.tooltip);
    var critical = heatmap.build([camp("g", 100, { worstSeverity: 1, compliance: 0, assessedIndicators: 1, notCountedIndicators: 0 }, [
      { standard_code: "TOILET", quantity: "1", required: "5", coveragePct: "20", severity: 1, assessment: "CRITICAL", functionalityText: "Not confirmed" }
    ])], standards)[0].cells.TOILET;
    assert.strictEqual(critical.state, "Error");
    assert.ok(critical.tooltip.indexOf("functionality not confirmed") > 0, critical.tooltip);
  });

  QUnit.test("says when a line is worked out from estimated households", function (assert) {
    var std = standards.concat([{ code: "CONTAINER", name: "Water containers", unit: "containers", basis: "Coverage" }]);
    var rows = heatmap.build([camp("h", 23, { worstSeverity: 2, compliance: 0, assessedIndicators: 1, notCountedIndicators: 0 }, [
      { standard_code: "CONTAINER", quantity: "8", required: "10", coveragePct: "80", severity: 2, assessment: "ATTENTION",
        targetBasis: "HOUSEHOLD", targetBasisText: "Households (estimated)" }
    ])], std);
    assert.ok(rows[0].cells.CONTAINER.tooltip.indexOf("Households (estimated)") > 0, rows[0].cells.CONTAINER.tooltip);
    assert.strictEqual(rows[0].cells.CONTAINER.state, "Warning", "the severity colour is unchanged");
  });

  QUnit.test("marks a line calculated with a local target, without changing its colour or words", function (assert) {
    var rows = heatmap.build([camp("t", 100, { worstSeverity: 1, compliance: 50, assessedIndicators: 2, notCountedIndicators: 0 }, [
      { standard_code: "WATER", quantity: "5000", required: "3000", daysOfCover: "1.7", severity: 1, assessment: "CRITICAL",
        perPerson: "30", referencePerPerson: "15", targetBasis: "LOCAL_TARGET" },
      { standard_code: "TOILET", quantity: "5", required: "5", coveragePct: "100", severity: 3, assessment: "MET",
        perPerson: "0.05", referencePerPerson: "0.05", targetBasis: "REFERENCE_FIGURE" }
    ])], standards);
    var water = rows[0].cells.WATER, toilet = rows[0].cells.TOILET;
    assert.strictEqual(water.localTarget, true);
    assert.strictEqual(water.state, "Error", "the severity colour is unchanged");
    assert.ok(water.tooltip.indexOf("local target 30 per person (reference 15)") > 0, water.tooltip);
    assert.notOk(toilet.localTarget, "a reference figure line is not marked");
    assert.strictEqual(toilet.tooltip.indexOf("local target"), -1);
  });

  QUnit.test("shows not decided, not applicable and no requirement as words, never as a gap", function (assert) {
    var std = standards.concat([{ code: "NET", name: "Mosquito nets", unit: "nets", basis: "Coverage" }]);
    var rows = heatmap.build([camp("d", 100, { worstSeverity: null, compliance: null, assessedIndicators: 0, notCountedIndicators: 0 }, [
      { standard_code: "NET", quantity: "0", required: null, severity: null, assessment: "NOT_DECIDED" },
      { standard_code: "WATER", quantity: "0", required: null, severity: null, assessment: "NOT_APPLICABLE" },
      { standard_code: "TOILET", quantity: null, required: null, severity: null, assessment: "NO_REQUIREMENT" }
    ])], std);
    var cells = rows[0].cells;
    assert.strictEqual(cells.NET.text, "Not decided");
    assert.strictEqual(cells.WATER.text, "Not applicable");
    assert.strictEqual(cells.TOILET.text, "No requirement");
    ["NET", "WATER", "TOILET"].forEach(function (c) {
      assert.strictEqual(cells[c].state, "None", c + " carries no colour");
      assert.strictEqual(cells[c].severity, 0, c + " is not a gap");
    });
    assert.strictEqual(cells.NET.tooltip, "Mosquito nets: Not decided, applicability not decided for this camp");
    assert.strictEqual(cells.WATER.tooltip.indexOf("0 /"), -1, "no quantity or requirement for a line that does not apply");
  });

  QUnit.test("shows a camp with nothing counted as not counted", function (assert) {
    var rows = heatmap.build([camp("u", 100, { worstSeverity: null, compliance: null, assessedIndicators: 0, notCountedIndicators: 2 }, [])], standards);
    assert.strictEqual(rows[0].state, "notCounted");
    assert.strictEqual(rows[0].stateText, "Not counted");
    assert.strictEqual(rows[0].compliance, null);
  });

  QUnit.test("uses the texts it is given", function (assert) {
    var rows = heatmap.build([camp("u", 100, { assessedIndicators: 0 }, [
      { standard_code: "WATER", quantity: null, severity: null, assessment: "NOT_COUNTED" }
    ])], standards, { notCounted: "Nicht gezählt" });
    assert.strictEqual(rows[0].cells.WATER.text, "Nicht gezählt");
  });

  QUnit.test("marks standards without a stock line", function (assert) {
    var rows = heatmap.build([camp("m", 10, { worstSeverity: 1, compliance: 0, assessedIndicators: 1 }, [])], standards);
    assert.strictEqual(rows[0].cells.TOILET.text, "–");
    assert.strictEqual(rows[0].cells.TOILET.tooltip, "Toilets: no stock line");
  });
});
