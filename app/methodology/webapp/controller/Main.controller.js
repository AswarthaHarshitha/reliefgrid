sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/format/DateFormat",
  "sap/ui/core/format/NumberFormat",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/StepInput",
  "sap/m/TextArea",
  "sap/m/MessageStrip",
  "sap/m/MessageBox",
  "sap/ui/layout/form/SimpleForm",
  "../model/formatter"
], function (Controller, DateFormat, NumberFormat, Dialog, Button, Label, StepInput, TextArea, MessageStrip, MessageBox, SimpleForm, formatter) {
  "use strict";

  var FIELDS = ["criticalDays", "warningDays", "criticalPercent", "warningPercent", "targetDays"];
  var number = NumberFormat.getFloatInstance({ maxFractionDigits: 2 });
  var dateTime = DateFormat.getDateTimeInstance({ style: "medium" });

  function values(row, prefix) {
    var v = {};
    FIELDS.forEach(function (f) {
      var key = prefix ? prefix + f.charAt(0).toUpperCase() + f.slice(1) : f;
      v[f] = row[key] === null || row[key] === undefined ? null : Number(row[key]);
    });
    return v;
  }

  return Controller.extend("reliefgrid.methodology.controller.Main", {
    formatter: formatter,

    onInit: function () {
      this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
      this._bundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var model = this.getOwnerComponent().getModel();
      model.setProperty("/settingsState", { status: "", canChange: false });
      model.setProperty("/settingsHistory", []);
      // The JSON file may still be loading; the planning rows are filled in once both are there.
      var loaded = model.getProperty("/planningChoices") ? Promise.resolve() : model.dataLoaded();
      this._ready = loaded.then(this._loadSettings.bind(this)).then(this._loadHousehold.bind(this));
    },

    // ---------------------------------------------------------------------
    // Planning settings: the values in force, never a copy
    // ---------------------------------------------------------------------

    _loadSettings: function () {
      var relief = this.getOwnerComponent().getModel("relief");
      var model = this.getOwnerComponent().getModel();
      var b = this._bundle;
      return Promise.all([
        relief.bindContext("/PlanningSettings('CURRENT')").requestObject(),
        relief.bindList("/PlanningSettingsChanges", null, null, null, { $orderby: "changedAt desc" }).requestContexts(0, 50),
        relief.bindContext("/planningAccess()").requestObject()
      ]).then(function (results) {
        var settings = values(results[0]);
        settings.version = Number(results[0].version);
        var history = results[1].map(function (c) { return c.getObject(); });
        this._settings = settings;
        this._fillPlanningRows(settings);
        var last = history[0];
        model.setProperty("/settingsState", {
          available: true,
          canChange: !!results[2].canChange,
          status: last
            ? b.getText("settingsLastChange", [dateTime.format(new Date(last.changedAt)), last.changedBy, last.reason])
            : b.getText("settingsDefaults")
        });
        model.setProperty("/settingsHistory", history.map(function (h) {
          return {
            changedAtText: dateTime.format(new Date(h.changedAt)),
            changedBy: h.changedBy,
            reason: h.reason,
            before: this._summary(values(h, "previous")),
            after: this._summary(values(h, "new"))
          };
        }.bind(this)));
      }.bind(this)).catch(function () {
        // Donors and other users without access see no threshold values rather than outdated ones.
        this._fillPlanningRows(null);
        model.setProperty("/settingsState", { available: false, canChange: false, status: b.getText("settingsRestricted") });
      }.bind(this));
    },

    // ---------------------------------------------------------------------
    // Household planning assumption (B4.3): separate from the planning settings
    // ---------------------------------------------------------------------

    _loadHousehold: function () {
      var relief = this.getOwnerComponent().getModel("relief");
      var model = this.getOwnerComponent().getModel();
      var b = this._bundle;
      var showSize = function (text) {
        (model.getProperty("/planningChoices") || []).forEach(function (row, i) {
          if (row.assumption) {
            model.setProperty("/planningChoices/" + i + "/value", text);
          }
        });
      };
      return Promise.all([
        relief.bindContext("/HouseholdAssumption('CURRENT')").requestObject(),
        relief.bindList("/HouseholdAssumptionChanges", null, null, null, { $orderby: "changedAt desc" }).requestContexts(0, 50),
        relief.bindContext("/planningAccess()").requestObject(),
        relief.bindList("/HouseholdSizeProposals", null, null, null, { $filter: "status eq 'PENDING'" }).requestContexts(0, 1)
      ]).then(function (results) {
        var a = results[0];
        var history = results[1].map(function (c) { return c.getObject(); });
        var access = results[2];
        var proposal = results[3].length ? results[3][0].getObject() : null;
        this._household = { size: Number(a.householdSize), version: Number(a.version) };
        this._proposal = proposal;
        showSize(b.getText("householdValue", [number.format(this._household.size)]));
        var last = history[0];
        var admin = !!access.canChange;
        var mine = !!proposal && proposal.proposedBy === access.user;
        model.setProperty("/householdState", {
          canChange: admin && !proposal,
          status: b.getText("householdStatus", [number.format(this._household.size)]) + " " + (last
            ? b.getText("householdLastChange", [dateTime.format(new Date(last.changedAt)), last.proposedBy || last.changedBy, last.changedBy, last.reason])
            : b.getText("householdDefault")),
          proposal: proposal ? b.getText("householdPending", [number.format(Number(proposal.previousSize)), number.format(Number(proposal.proposedSize)),
            proposal.proposedBy, dateTime.format(new Date(proposal.proposedAt)), proposal.reason]) + (mine ? " " + b.getText("householdWaitingForOther") : "") : "",
          canDecide: admin && !!proposal && !mine,
          canWithdraw: admin && mine
        });
        model.setProperty("/householdHistory", history.map(function (h) {
          return {
            changedAtText: dateTime.format(new Date(h.changedAt)),
            proposedBy: h.proposedBy || b.getText("householdNoProposal"),
            changedBy: h.changedBy,
            reason: h.reason,
            before: number.format(Number(h.previousSize)),
            after: number.format(Number(h.newSize))
          };
        }));
      }.bind(this)).catch(function () {
        // Donors and other users without access see no value rather than an outdated one.
        showSize(b.getText("valueRestricted"));
        model.setProperty("/householdState", { canChange: false, status: b.getText("householdRestricted"), proposal: "" });
        model.setProperty("/householdHistory", []);
      });
    },

    /** Proposes a household-size change; it takes effect only when another Administrator approves it. */
    onChangeHousehold: function () {
      var b = this._bundle;
      var size = new StepInput({ value: this._household.size, min: 1, max: 99.9, step: 0.1, displayValuePrecision: 1, width: "100%" });
      var reason = new TextArea({ rows: 3, maxLength: 500, width: "100%", required: true, growing: true });
      var dialog = new Dialog({
        title: b.getText("changeHousehold"),
        contentWidth: "32rem",
        content: [
          new MessageStrip({ text: b.getText("householdImpact"), type: "Warning", showIcon: true }).addStyleClass("sapUiSmallMargin"),
          new SimpleForm({ editable: true, layout: "ResponsiveGridLayout", labelSpanM: 5, labelSpanL: 5, content: [
            new Label({ text: b.getText("lblHouseholdSize"), labelFor: size, required: true }), size,
            new Label({ text: b.getText("lblReason"), labelFor: reason, required: true }), reason
          ] })
        ],
        beginButton: new Button({
          text: b.getText("proposeHousehold"),
          type: "Emphasized",
          press: function () {
            var text = reason.getValue().trim();
            reason.setValueState(text ? "None" : "Error").setValueStateText(b.getText("reasonRequired"));
            if (text) {
              this._householdAction("/HouseholdAssumption('CURRENT')/ReliefService.proposeSize(...)",
                { householdSize: String(size.getValue()), reason: text, version: this._household.version }, dialog, function () {
                  MessageBox.information(b.getText("householdProposedText"), { title: b.getText("householdProposedTitle") });
                });
            }
          }.bind(this)
        }),
        endButton: new Button({ text: b.getText("cancel"), press: function () { dialog.close(); } }),
        afterClose: function () { dialog.destroy(); }
      });
      this.getView().addDependent(dialog);
      dialog.open();
    },

    /** Approval by an Administrator other than the proposer. */
    onApproveHousehold: function () {
      var b = this._bundle;
      var p = this._proposal;
      MessageBox.confirm(b.getText("householdApproveConfirm", [number.format(Number(p.previousSize)), number.format(Number(p.proposedSize)), p.proposedBy]), {
        title: b.getText("approveHousehold"),
        actions: [b.getText("approveHousehold"), MessageBox.Action.CANCEL],
        emphasizedAction: b.getText("approveHousehold"),
        onClose: function (choice) {
          if (choice !== b.getText("approveHousehold")) {
            return;
          }
          this._householdAction("/HouseholdSizeProposals(" + p.ID + ")/ReliefService.approve(...)", {}, null, function (result) {
            MessageBox.success(b.getText("householdSavedText", [result.linesChanged, result.campsChanged, result.requestsFlagged]),
              { title: b.getText("householdSavedTitle") });
          });
        }.bind(this)
      });
    },

    /** Rejection by an Administrator other than the proposer, with a reason. */
    onRejectHousehold: function () {
      var b = this._bundle;
      var p = this._proposal;
      var reason = new TextArea({ rows: 3, maxLength: 500, width: "100%", required: true, growing: true });
      var dialog = new Dialog({
        title: b.getText("rejectHousehold"),
        contentWidth: "32rem",
        content: [new SimpleForm({ editable: true, layout: "ResponsiveGridLayout", labelSpanM: 5, labelSpanL: 5, content: [
          new Label({ text: b.getText("lblReason"), labelFor: reason, required: true }), reason
        ] })],
        beginButton: new Button({
          text: b.getText("rejectHousehold"),
          type: "Reject",
          press: function () {
            var text = reason.getValue().trim();
            reason.setValueState(text ? "None" : "Error").setValueStateText(b.getText("reasonRequired"));
            if (text) {
              this._householdAction("/HouseholdSizeProposals(" + p.ID + ")/ReliefService.rejectProposal(...)", { reason: text }, dialog, function () {
                MessageBox.information(b.getText("householdRejectedText"), { title: b.getText("rejectHousehold") });
              });
            }
          }.bind(this)
        }),
        endButton: new Button({ text: b.getText("cancel"), press: function () { dialog.close(); } }),
        afterClose: function () { dialog.destroy(); }
      });
      this.getView().addDependent(dialog);
      dialog.open();
    },

    /** Withdrawal by the proposer. */
    onWithdrawHousehold: function () {
      var b = this._bundle;
      var p = this._proposal;
      MessageBox.confirm(b.getText("householdWithdrawConfirm"), {
        title: b.getText("withdrawHousehold"),
        onClose: function (choice) {
          if (choice === MessageBox.Action.OK) {
            this._householdAction("/HouseholdSizeProposals(" + p.ID + ")/ReliefService.withdraw(...)", {}, null, function () {
              MessageBox.information(b.getText("householdWithdrawnText"), { title: b.getText("withdrawHousehold") });
            });
          }
        }.bind(this)
      });
    },

    _householdAction: function (path, parameters, dialog, done) {
      var relief = this.getOwnerComponent().getModel("relief");
      var action = relief.bindContext(path);
      Object.keys(parameters).forEach(function (k) { action.setParameter(k, parameters[k]); });
      if (dialog) {
        dialog.setBusy(true);
      }
      return action.invoke()
        .then(function () {
          var result = action.getBoundContext() && action.getBoundContext().getObject();
          if (dialog) {
            dialog.close();
          }
          done(result || {});
          return this._loadHousehold();
        }.bind(this))
        .catch(function (error) {
          if (dialog) {
            dialog.setBusy(false);
          }
          MessageBox.error(error.message);
          return this._loadHousehold();
        }.bind(this));
    },

    _fillPlanningRows: function (settings) {
      var model = this.getOwnerComponent().getModel();
      (model.getProperty("/planningChoices") || []).forEach(function (row, i) {
        if (!row.setting) {
          return;
        }
        model.setProperty("/planningChoices/" + i + "/value", settings
          ? row.template.replace("{0}", number.format(settings[row.setting]))
          : this._bundle.getText("valueRestricted"));
      }.bind(this));
    },

    _summary: function (v) {
      return this._bundle.getText("settingsSummary", [v.criticalDays, v.criticalPercent, v.warningDays, v.warningPercent, v.targetDays]
        .map(function (n) { return n === null ? "–" : number.format(n); }));
    },

    onChangeSettings: function () {
      var b = this._bundle;
      var s = this._settings;
      var input = function (value, step, precision, max) {
        return new StepInput({ value: value, min: step, max: max, step: step, displayValuePrecision: precision, width: "100%" });
      };
      var fields = {
        criticalDays: input(s.criticalDays, 0.5, 2, 90),
        warningDays: input(s.warningDays, 0.5, 2, 90),
        criticalPercent: input(s.criticalPercent, 1, 0, 100),
        warningPercent: input(s.warningPercent, 1, 0, 100),
        targetDays: input(s.targetDays, 1, 0, 90)
      };
      var reason = new TextArea({ rows: 3, maxLength: 500, width: "100%", required: true, growing: true });
      var labels = { criticalDays: "lblCriticalDays", warningDays: "lblWarningDays", criticalPercent: "lblCriticalPercent",
        warningPercent: "lblWarningPercent", targetDays: "lblTargetDays" };
      var content = [];
      FIELDS.forEach(function (f) {
        content.push(new Label({ text: b.getText(labels[f]), labelFor: fields[f], required: true }), fields[f]);
      });
      content.push(new Label({ text: b.getText("lblReason"), labelFor: reason, required: true }), reason);

      var dialog = new Dialog({
        title: b.getText("dialogTitle"),
        contentWidth: "36rem",
        content: [
          new MessageStrip({ text: b.getText("dialogImpact"), type: "Warning", showIcon: true }).addStyleClass("sapUiSmallMargin"),
          new SimpleForm({ editable: true, layout: "ResponsiveGridLayout", labelSpanM: 6, labelSpanL: 6, content: content })
        ],
        beginButton: new Button({
          text: b.getText("save"),
          type: "Emphasized",
          press: function () {
            var text = reason.getValue().trim();
            reason.setValueState(text ? "None" : "Error").setValueStateText(b.getText("reasonRequired"));
            if (!text) {
              return;
            }
            var next = {};
            FIELDS.forEach(function (f) { next[f] = fields[f].getValue(); });
            this._saveSettings(next, text, this._settings.version, dialog);
          }.bind(this)
        }),
        endButton: new Button({ text: b.getText("cancel"), press: function () { dialog.close(); } }),
        afterClose: function () { dialog.destroy(); }
      });
      this.getView().addDependent(dialog);
      dialog.open();
    },

    _saveSettings: function (next, reason, version, dialog) {
      var b = this._bundle;
      var relief = this.getOwnerComponent().getModel("relief");
      var action = relief.bindContext("/PlanningSettings('CURRENT')/ReliefService.change(...)");
      FIELDS.forEach(function (f) {
        // Edm.Decimal travels as a string; targetDays is an integer
        action.setParameter(f, f === "targetDays" ? next[f] : String(next[f]));
      });
      action.setParameter("reason", reason);
      // the version this dialog was opened with; a change made meanwhile by someone else is refused
      action.setParameter("version", version);
      dialog.setBusy(true);
      action.invoke()
        .then(function () {
          var result = action.getBoundContext().getObject();
          dialog.close();
          var text = b.getText("savedText", [result.linesChanged, result.campsChanged]);
          if (next.targetDays < next.warningDays) {
            MessageBox.warning(text + "\n\n" + b.getText("savedWarning", [next.targetDays, next.warningDays]), { title: b.getText("savedTitle") });
          } else {
            MessageBox.success(text, { title: b.getText("savedTitle") });
          }
          return this._loadSettings();
        }.bind(this))
        .catch(function (error) {
          dialog.setBusy(false);
          MessageBox.error(error.message);
          return this._loadSettings();
        }.bind(this));
    },

    // ---------------------------------------------------------------------
    // Indicators
    // ---------------------------------------------------------------------

    verificationText: function (status) {
      return status ? this._bundle.getText("verification." + status) : "";
    },

    valueTypeText: function (type) {
      return type ? this._bundle.getText("valueType." + type) : "";
    },

    calculationValue: function (calculation) {
      return calculation ? formatter.calculation({ value: calculation.value, unit: "", per: "" }).trim() : "";
    },

    quoteLabel: function (page) {
      return page ? this._bundle.getText("quoteLabel", [page]) : "";
    },

    pagesText: function (pages) {
      return pages ? this._bundle.getText("pageShort", [pages]) : "";
    },

    /** A row in the summary table jumps to that indicator's subsection. */
    onIndicatorPress: function (event) {
      var index = Number(event.getSource().getBindingContext().getPath().split("/").pop());
      var subSection = this.byId("indicators").getSubSections()[index];
      if (subSection) {
        this.byId("page").scrollToSection(subSection.getId());
      }
    }
  });
});
