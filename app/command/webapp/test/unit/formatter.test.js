sap.ui.define(["reliefgrid/command/model/formatter"], function (formatter) {
  "use strict";

  QUnit.module("formatter");

  QUnit.test("maps severity to value states, icons and chart colours", function (assert) {
    assert.strictEqual(formatter.severityState(1), "Error");
    assert.strictEqual(formatter.severityState(2), "Warning");
    assert.strictEqual(formatter.severityState(3), "Success");
    assert.strictEqual(formatter.severityState(0), "None");
    assert.strictEqual(formatter.severityIcon(1), "sap-icon://error");
    assert.strictEqual(formatter.severityColor(2), "Critical");
    assert.strictEqual(formatter.severityColor(undefined), "Neutral");
  });

  QUnit.test("shows days of cover for consumables", function (assert) {
    assert.strictEqual(formatter.coverText("Consumption", "3.25", null), "3.3 d");
    assert.strictEqual(formatter.coverText("Consumption", 0, null), "0 d");
    assert.strictEqual(formatter.coverText("Consumption", 250, null), "99+ d");
    assert.strictEqual(formatter.coverText("Consumption", null, null), "–");
  });

  QUnit.test("shows percentage of the minimum for infrastructure", function (assert) {
    assert.strictEqual(formatter.coverText("Coverage", null, "49.9"), "49 %");
    assert.strictEqual(formatter.coverText("Coverage", null, 100), "100 %");
    assert.strictEqual(formatter.coverText("Coverage", null, 5000), "999+ %");
  });

  QUnit.test("formats numbers from OData decimal strings", function (assert) {
    assert.strictEqual(formatter.integer("12500"), "12,500");
    assert.strictEqual(formatter.decimal("1234.56"), "1,234.6");
    assert.strictEqual(formatter.compact(980), "980");
    assert.strictEqual(formatter.compact(12400), "12.4K");
    assert.strictEqual(formatter.compact(null), "0");
    assert.strictEqual(formatter.integer(null), "");
  });

  QUnit.test("classifies delivery dates", function (assert) {
    assert.strictEqual(formatter.etaStatus(null, "2026-11-02"), "none");
    assert.strictEqual(formatter.etaStatus("2026-11-01", "2026-11-02"), "overdue");
    assert.strictEqual(formatter.etaStatus("2026-11-02", "2026-11-02"), "today");
    assert.strictEqual(formatter.etaStatus("2026-11-09", "2026-11-02"), "upcoming");
    assert.strictEqual(formatter.etaState("2026-11-01", "2026-11-02"), "Error");
    assert.strictEqual(formatter.etaState("2026-11-09", "2026-11-02"), "None");
  });

  QUnit.test("keeps a missing population visibly empty", function (assert) {
    assert.strictEqual(formatter.people(null), "–");
    assert.strictEqual(formatter.people(undefined), "–");
    assert.strictEqual(formatter.people(0), "0");
    assert.strictEqual(formatter.people(1200), "1,200");
  });

  QUnit.test("formats count times and leaves missing ones empty", function (assert) {
    assert.strictEqual(formatter.dateTime(null), "");
    assert.strictEqual(formatter.dateTime("not a date"), "");
    assert.ok(formatter.dateTime("2026-11-02T08:00:00Z").indexOf("2026") >= 0);
  });
});
