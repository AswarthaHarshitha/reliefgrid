sap.ui.define(["sap/ui/core/format/NumberFormat", "sap/ui/core/format/DateFormat"], function (NumberFormat, DateFormat) {
  "use strict";

  var dateTime = DateFormat.getDateTimeInstance({ style: "medium" });
  var integer = NumberFormat.getIntegerInstance({ groupingEnabled: true });
  var oneDecimal = NumberFormat.getFloatInstance({ groupingEnabled: true, maxFractionDigits: 1 });
  var compact = NumberFormat.getFloatInstance({ style: "short", maxFractionDigits: 1 });

  var STATE = { 1: "Error", 2: "Warning", 3: "Success" };
  var ICON = { 1: "sap-icon://error", 2: "sap-icon://alert", 3: "sap-icon://sys-enter-2" };
  var COLOR = { 1: "Error", 2: "Critical", 3: "Good" };

  function toNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    var n = Number(value);
    return isNaN(n) ? null : n;
  }

  /** Compares an ISO date (yyyy-mm-dd) with today: overdue, due today or later. */
  function etaStatus(eta, today) {
    if (!eta) {
      return "none";
    }
    var now = today || new Date().toISOString().slice(0, 10);
    if (eta < now) {
      return "overdue";
    }
    return eta === now ? "today" : "upcoming";
  }

  return {
    toNumber: toNumber,

    /** Severity 1/2/3 (critical, below minimum, adequate) to a ValueState. */
    severityState: function (severity) {
      return STATE[severity] || "None";
    },

    severityIcon: function (severity) {
      return ICON[severity] || "";
    },

    /** Severity to a microchart ValueColor. */
    severityColor: function (severity) {
      return COLOR[severity] || "Neutral";
    },

    /** ISO timestamp to a medium date and time; empty when there is none. */
    dateTime: function (value) {
      if (!value) {
        return "";
      }
      var d = new Date(value);
      return isNaN(d.getTime()) ? "" : dateTime.format(d);
    },

    /** People sheltered: empty population stays visibly empty, never 0. */
    people: function (value) {
      var n = toNumber(value);
      return n === null ? "–" : integer.format(n);
    },

    integer: function (value) {
      var n = toNumber(value);
      return n === null ? "" : integer.format(n);
    },

    decimal: function (value) {
      var n = toNumber(value);
      return n === null ? "" : oneDecimal.format(n);
    },

    /** 12,400 becomes "12.4K"; small numbers stay exact. */
    compact: function (value) {
      var n = toNumber(value);
      if (n === null) {
        return "0";
      }
      return Math.abs(n) < 10000 ? integer.format(n) : compact.format(n);
    },

    /**
     * Heatmap cell text: consumables show days of cover, infrastructure shows
     * percentage of the reference requirement.
     */
    coverText: function (basis, daysOfCover, coveragePct) {
      if (basis === "Consumption") {
        var days = toNumber(daysOfCover);
        if (days === null) {
          return "–";
        }
        return days >= 100 ? "99+ d" : oneDecimal.format(days) + " d";
      }
      var pct = toNumber(coveragePct);
      if (pct === null) {
        return "–";
      }
      return pct >= 1000 ? "999+ %" : integer.format(Math.floor(pct)) + " %";
    },

    etaStatus: etaStatus,

    etaState: function (eta, today) {
      return { overdue: "Error", today: "Warning" }[etaStatus(eta, today)] || "None";
    }
  };
});
