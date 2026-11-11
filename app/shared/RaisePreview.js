/**
 * UX-05: requests are reviewed before they are published to donors. Shows, for
 * one camp, every request Raise Requests would publish now, with how each
 * quantity was worked out, and lets the user change the target days. Resolves
 * with { targetDays } when the user publishes, or null when cancelled; the
 * caller publishes, so each app keeps its own result messages.
 * Used by the Command Center and by Manage Relief Camps.
 */
sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/StepInput",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/Text",
  "sap/m/ObjectNumber",
  "sap/m/ObjectStatus",
  "sap/m/MessageStrip",
  "sap/m/HBox",
  "sap/m/VBox",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/format/NumberFormat",
  "sap/ui/core/format/DateFormat"
], function (Dialog, Button, Label, StepInput, Table, Column, ColumnListItem, Text, ObjectNumber, ObjectStatus,
  MessageStrip, HBox, VBox, JSONModel, NumberFormat, DateFormat) {
  "use strict";

  var number = NumberFormat.getFloatInstance({ maxFractionDigits: 1, groupingEnabled: true });
  var date = DateFormat.getDateInstance({ style: "medium" });
  var PRIORITY = { 1: ["Critical", "Error"], 2: ["Needs attention", "Warning"], 3: ["Met", "Success"] };

  var TEXTS = {
    title: "Review and Publish Requests",
    intro: "These requests for {0} will be published to donors at once. Check each quantity before publishing.",
    targetDays: "Days of supply to reach (consumables)",
    colIndicator: "Indicator",
    colNeed: "Requirement",
    colTarget: "Top up to",
    colOnHand: "Usable on hand",
    colIncoming: "Still to arrive",
    colRequest: "Request",
    colPriority: "Priority",
    colNeededBy: "Needed by",
    perDay: "{0} {1} per day",
    total: "{0} {1} in total",
    forDays: "{0} {1} for {2} days",
    publish: "Publish {0} Requests",
    publishOne: "Publish 1 Request",
    cancel: "Cancel",
    nothing: "Nothing to request: every counted, assessed line is covered by stock and requests still to arrive.",
    notAssessed: "Nothing can be requested: the camp has no people recorded, so no indicator is assessed. Record the population first.",
    skippedNotCounted: "Skipped: {0} indicators never counted, so no confirmed shortage can be calculated. Record stock counts first.",
    skippedNotVerified: "Skipped: {0} toilet or tap lines whose functionality is not confirmed. Record the functional units with the next count.",
    skippedNotDecided: "Skipped: {0} indicators not decided, not applicable or without a requirement.",
    loading: "Working out the requests…"
  };

  function format(text, args) {
    return text.replace(/\{(\d)\}/g, function (m, i) { return args[i] === undefined ? "" : args[i]; });
  }

  /**
   * @param {object} options model: the ReliefService OData V4 model; campID, campName;
   *   targetDays: the starting value (the stored replenishment target)
   * @returns {Promise<{targetDays: number}|null>}
   */
  function open(options) {
    var view = new JSONModel({ targetDays: options.targetDays || 7, lines: [], busy: true, loaded: false, skipped: "" });
    var load = function () {
      view.setProperty("/busy", true);
      var fn = options.model.bindContext("/Camps(ID=" + options.campID + ",IsActiveEntity=true)/ReliefService.previewRequests(...)");
      fn.setParameter("targetDays", Number(view.getProperty("/targetDays")));
      // what is left out, and why: lines never counted, not confirmed or not established are never requested
      var health = options.model.bindContext("/Camps(ID=" + options.campID + ",IsActiveEntity=true)/health").requestObject().catch(function () { return null; });
      var people = options.model.bindContext("/Camps(ID=" + options.campID + ",IsActiveEntity=true)").requestObject().catch(function () { return null; });
      Promise.all([health, people]).then(function (r) {
        var h = r[0] || {};
        var camp = r[1] || {};
        var notes = [];
        if (!(camp.headcount > 0)) {
          notes.push(TEXTS.notAssessed);
        } else {
          if (h.notCountedIndicators) { notes.push(format(TEXTS.skippedNotCounted, [h.notCountedIndicators])); }
          if (h.notVerifiedIndicators) { notes.push(format(TEXTS.skippedNotVerified, [h.notVerifiedIndicators])); }
          var undecided = (h.notDecidedIndicators || 0) + (h.notApplicableIndicators || 0) + (h.noRequirementIndicators || 0);
          if (undecided) { notes.push(format(TEXTS.skippedNotDecided, [undecided])); }
        }
        view.setProperty("/skipped", notes.join(" "));
      });
      return fn.invoke().then(function () {
        var result = fn.getBoundContext().getObject() || {};
        var lines = (result.value || []).map(function (l) {
          var consumption = l.basis === "Consumption";
          return Object.assign({}, l, {
            needText: format(consumption ? TEXTS.perDay : TEXTS.total, [number.format(Number(l.requirement)), l.unit]),
            targetText: consumption ? format(TEXTS.forDays, [number.format(Number(l.target)), l.unit, l.targetDays])
              : format(TEXTS.total, [number.format(Number(l.target)), l.unit]),
            quantityText: number.format(Number(l.quantity)),
            onHandText: number.format(Number(l.onHand)) + " " + l.unit,
            incomingText: number.format(Number(l.incoming)) + " " + l.unit,
            priorityText: (PRIORITY[l.priority] || ["", "None"])[0],
            priorityState: (PRIORITY[l.priority] || ["", "None"])[1],
            neededByText: l.neededBy ? date.format(new Date(l.neededBy + "T00:00:00")) : ""
          });
        });
        view.setProperty("/lines", lines);
        view.setProperty("/loaded", true);
      }).finally(function () {
        view.setProperty("/busy", false);
      });
    };

    return new Promise(function (resolve, reject) {
      var decided = false;
      var table = new Table({
        busy: "{/busy}",
        busyIndicatorDelay: 0,
        popinLayout: "GridSmall",
        noData: new Text({ text: "{= ${/loaded} ? '" + TEXTS.nothing.replace(/'/g, "\\'") + "' : '" + TEXTS.loading + "' }" }),
        columns: [
          new Column({ width: "11rem", header: new Text({ text: TEXTS.colIndicator }) }),
          new Column({ minScreenWidth: "Tablet", demandPopin: true, header: new Text({ text: TEXTS.colNeed }) }),
          new Column({ minScreenWidth: "Tablet", demandPopin: true, header: new Text({ text: TEXTS.colTarget }) }),
          new Column({ hAlign: "End", minScreenWidth: "Tablet", demandPopin: true, header: new Text({ text: TEXTS.colOnHand }) }),
          new Column({ hAlign: "End", minScreenWidth: "Tablet", demandPopin: true, header: new Text({ text: TEXTS.colIncoming }) }),
          new Column({ hAlign: "End", header: new Text({ text: TEXTS.colRequest }) }),
          new Column({ minScreenWidth: "Tablet", demandPopin: true, header: new Text({ text: TEXTS.colPriority }) }),
          new Column({ minScreenWidth: "Tablet", demandPopin: true, header: new Text({ text: TEXTS.colNeededBy }) })
        ],
        items: {
          path: "/lines",
          template: new ColumnListItem({ cells: [
            new Text({ text: "{standardName}" }),
            new Text({ text: "{needText}" }),
            new Text({ text: "{targetText}" }),
            new Text({ text: "{onHandText}" }),
            new Text({ text: "{incomingText}" }),
            new ObjectNumber({ number: "{quantityText}", unit: "{unit}", emphasized: true }),
            new ObjectStatus({ text: "{priorityText}", state: "{priorityState}" }),
            new Text({ text: "{neededByText}" })
          ] })
        }
      });
      var target = new StepInput({ value: "{/targetDays}", min: 1, max: 90, step: 1, width: "8rem", change: load });
      var publish = new Button({
        text: "{= ${/lines}.length === 1 ? '" + TEXTS.publishOne + "' : '" + TEXTS.publish.replace("{0}", "' + ${/lines}.length + '") + "' }",
        type: "Emphasized",
        enabled: "{= !${/busy} && ${/lines}.length > 0 }",
        press: function () {
          decided = true;
          dialog.close();
          resolve({ targetDays: view.getProperty("/targetDays") });
        }
      });
      var dialog = new Dialog({
        title: TEXTS.title,
        contentWidth: "60rem",
        resizable: true,
        draggable: true,
        content: [new VBox({ renderType: "Bare", items: [
          new MessageStrip({ text: format(TEXTS.intro, [options.campName || ""]), type: "Information", showIcon: true }).addStyleClass("sapUiSmallMarginBottom"),
          new HBox({ alignItems: "Center", renderType: "Bare", items: [new Label({ text: TEXTS.targetDays, labelFor: target }).addStyleClass("sapUiSmallMarginEnd"), target] })
            .addStyleClass("sapUiSmallMarginBottom"),
          table,
          new MessageStrip({ text: "{/skipped}", type: "Warning", showIcon: true, visible: "{= !!${/skipped} }" }).addStyleClass("sapUiSmallMarginTop")
        ] }).addStyleClass("sapUiSmallMargin")],
        beginButton: publish,
        endButton: new Button({ text: TEXTS.cancel, press: function () { dialog.close(); } }),
        afterClose: function () {
          dialog.destroy();
          if (!decided) {
            resolve(null);
          }
        }
      });
      dialog.setModel(view);
      dialog.open();
      load().catch(function (error) {
        decided = true;
        dialog.close();
        reject(error);
      });
    });
  }

  return { open: open, TEXTS: TEXTS };
});
