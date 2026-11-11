sap.ui.define(["reliefgrid/methodology/model/formatter"], function (formatter) {
  "use strict";

  QUnit.module("formatter");

  QUnit.test("labels every verification status with a state and an icon", function (assert) {
    assert.strictEqual(formatter.verificationState("verified"), "Success");
    assert.strictEqual(formatter.verificationState("conditional"), "Information");
    assert.strictEqual(formatter.verificationState("notSphere"), "Error");
    assert.strictEqual(formatter.verificationState("unknown"), "None");
    assert.strictEqual(formatter.verificationIcon("notSphere"), "sap-icon://decline");
    assert.strictEqual(formatter.verificationIcon(undefined), "");
  });

  QUnit.test("marks planning assumptions differently from Sphere references", function (assert) {
    assert.strictEqual(formatter.valueTypeState("sphere"), "Information");
    assert.strictEqual(formatter.valueTypeState("converted"), "Information");
    assert.strictEqual(formatter.valueTypeState("planning"), "Warning");
    assert.notStrictEqual(formatter.valueTypeIcon("sphere"), formatter.valueTypeIcon("planning"));
  });

  QUnit.test("shows calculation values readably", function (assert) {
    assert.strictEqual(formatter.calculation({ value: 15, unit: "litres", per: "per person per day" }), "15 litres per person per day");
    assert.strictEqual(formatter.calculation({ value: 8.333333, unit: "grams", per: "per person per day" }), "8.3333 grams per person per day");
    assert.strictEqual(formatter.calculation({ value: 1, unit: "rations", per: "per person per day", text: "1 ration pack per person per day" }),
      "1 ration pack per person per day");
    assert.strictEqual(formatter.calculation(null), "");
  });

  QUnit.test("shows the Sphere reference, preferring its display text", function (assert) {
    assert.strictEqual(formatter.referenceText({ value: "250", unit: "grams per person per month" }), "250 grams per person per month");
    assert.strictEqual(formatter.referenceText({ value: "No ratio given", unit: "nets", text: "No ratio given; nets “where needed”" }),
      "No ratio given; nets “where needed”");
  });

  QUnit.test("builds an escaped list", function (assert) {
    assert.strictEqual(formatter.bulletList(["a < b", "c"]), "<ul><li>a &lt; b</li><li>c</li></ul>");
    assert.strictEqual(formatter.bulletList([]), "");
  });

  QUnit.test("counts indicators by kind of calculation value", function (assert) {
    var indicators = [{ valueType: "sphere" }, { valueType: "converted" }, { valueType: "planning" }, { valueType: "sphere" }];
    assert.strictEqual(formatter.count(indicators, "sphere"), 2);
    assert.strictEqual(formatter.count(indicators, "converted,planning"), 2);
  });
});
