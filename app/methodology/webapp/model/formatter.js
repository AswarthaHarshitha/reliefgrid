sap.ui.define([], function () {
  "use strict";

  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
  var escape = function (text) {
    return String(text).replace(/[&<>"']/g, function (c) { return ENTITIES[c]; });
  };

  var VALUE_TYPE = {
    sphere: { state: "Information", icon: "sap-icon://course-book" },
    converted: { state: "Information", icon: "sap-icon://simulate" },
    planning: { state: "Warning", icon: "sap-icon://user-edit" },
    none: { state: "None", icon: "sap-icon://status-inactive" }
  };

  var VERIFICATION = {
    verified: { state: "Success", icon: "sap-icon://sys-enter-2" },
    conditional: { state: "Information", icon: "sap-icon://hint" },
    notSphere: { state: "Error", icon: "sap-icon://decline" }
  };

  var lookup = function (table, key, field) {
    return (table[key] || {})[field] || (field === "state" ? "None" : "");
  };

  return {
    valueTypeState: function (type) { return lookup(VALUE_TYPE, type, "state"); },
    valueTypeIcon: function (type) { return lookup(VALUE_TYPE, type, "icon"); },
    verificationState: function (status) { return lookup(VERIFICATION, status, "state"); },
    verificationIcon: function (status) { return lookup(VERIFICATION, status, "icon"); },

    /** Calculation values keep up to six decimals in the data; four are enough to read. */
    calculation: function (calculation) {
      if (!calculation) return "";
      if (calculation.text) return calculation.text;
      if (calculation.value === null || calculation.value === undefined) return "–";
      var value = Number(calculation.value);
      var shown = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
      return shown + " " + calculation.unit + " " + calculation.per;
    },

    referenceText: function (reference) {
      return reference ? reference.text || reference.value + " " + reference.unit : "";
    },

    /** A real list for screen readers; every item is escaped before it becomes markup. */
    bulletList: function (items) {
      if (!items || !items.length) return "";
      return "<ul>" + items.map(function (item) { return "<li>" + escape(item) + "</li>"; }).join("") + "</ul>";
    },

    count: function (indicators, valueTypes) {
      var wanted = valueTypes.split(",");
      return (indicators || []).filter(function (i) { return wanted.indexOf(i.valueType) >= 0; }).length;
    }
  };
});
