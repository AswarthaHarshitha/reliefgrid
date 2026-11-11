sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/format/DateFormat",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/Text",
  "sap/m/ObjectIdentifier",
  "sap/m/ObjectNumber",
  "sap/m/ObjectStatus",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/StepInput",
  "sap/m/VBox",
  "sap/m/HBox",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/suite/ui/microchart/RadialMicroChart",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/Select",
  "sap/ui/core/Item",
  "sap/m/TextArea",
  "sap/m/CheckBox",
  "sap/m/MessageStrip",
  "sap/m/Table",
  "../model/formatter",
  "../model/heatmap"
], function (
  Controller, JSONModel, DateFormat, Column, ColumnListItem, Text, ObjectIdentifier, ObjectNumber,
  ObjectStatus, Dialog, Button, Label, StepInput, VBox, HBox, MessageToast, MessageBox, RadialMicroChart,
  Filter, FilterOperator, Select, Item, TextArea, CheckBox, MessageStrip, Table,
  formatter, heatmap
) {
  "use strict";

  var timeFormat = DateFormat.getTimeInstance({ style: "short" });
  var dateFormat = DateFormat.getDateInstance({ style: "medium" });
  /** UX-03: the refresh time is the browser's clock, so it is labelled with the browser's time zone. */
  function localZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
    } catch (e) {
      return "local time";
    }
  }
  /** Active camps read at once; the server's page limit is the same (ARCH-09). */
  var CAMP_LIMIT = 1000;

  return Controller.extend("reliefgrid.command.controller.Main", {
    formatter: formatter,

    onInit: function () {
      this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
      this._view = new JSONModel({
        busy: true,
        tab: "heatmap",
        subtitle: "",
        snapped: "",
        kpi: {},
        kpiText: {},
        text: {},
        attention: [],
        targets: [],
        camps: [],
        standards: []
      });
      this.getView().setModel(this._view, "view");
      this._bundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      this.load();
    },

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    load: function () {
      var model = this.getOwnerComponent().getModel();
      var standards = model.bindList("/Standards", null, null, null, {
        $select: "code,name,unit,basis,sortOrder,sector_code",
        $expand: "sector($select=code,name)",
        $orderby: "sortOrder"
      }).requestContexts(0, 100);
      // ARCH-09: the total is counted, so a cut-off list is said, never silent
      var campBinding = model.bindList("/Camps", null, null, null, {
        $count: true,
        $filter: "IsActiveEntity eq true and status_code eq 'ACTIVE'",
        $select: "ID,name,district,region,headcount,childrenUnder5",
        $expand: "hazard($select=name),health,stock($select=ID,standard_code,quantity,required,daysOfCover,coveragePct,severity,assessment,countedAt,perPerson,referencePerPerson,targetBasis,targetBasisText,functionalUnits,functionalityText)"
      });
      var camps = campBinding.requestContexts(0, CAMP_LIMIT);
      var overview = model.bindContext("/overview()").requestObject();
      var settings = model.bindContext("/PlanningSettings('CURRENT')").requestObject();
      var attention = model.bindContext("/attention()").requestObject();
      var targets = model.bindContext("/localTargets()").requestObject();
      var operation = model.bindContext("/operation()").requestObject();
      var actNow = model.bindContext("/actNow()").requestObject();

      this._view.setProperty("/busy", true);
      return Promise.all([standards, camps, overview, settings, attention, targets, operation, actNow])
        .then(function (results) {
          // UX-09: indicators grouped by sector, in reference order within each sector
          var standardList = results[0].map(function (c) { return c.getObject(); });
          var sectorRank = {};
          standardList.forEach(function (s) {
            var key = s.sector_code || "";
            sectorRank[key] = Math.min(sectorRank[key] === undefined ? Infinity : sectorRank[key], s.sortOrder || 0);
          });
          standardList.sort(function (a, c) {
            return sectorRank[a.sector_code || ""] - sectorRank[c.sector_code || ""] || (a.sortOrder || 0) - (c.sortOrder || 0);
          });
          var campList = results[1].map(function (c) { return c.getObject(); });
          // ARCH-08: due and overdue are judged on the operation's calendar day, as on the server
          this._today = results[6].today;
          this._view.setProperty("/today", this._today);
          var total = campBinding.getCount();
          this._view.setProperty("/campsNotice", total > campList.length
            ? this._bundle.getText("campsTruncated", [campList.length, total]) : "");
          this._timeZone = results[6].timeZone;
          this._showActNow(results[7].value || []);
          this._showOverview(results[2], campList.length);
          this._showSettings(results[3]);
          this._showAttention(results[4].value || []);
          this._showTargets(results[5].value || []);
          if (!this._columnsBuilt) {
            this._buildHeatmapColumns(standardList);
          }
          this._view.setProperty("/standards", standardList);
          this._view.setProperty("/camps", heatmap.build(campList, standardList, this._heatmapTexts()));
          this._fillFilters(campList);
        }.bind(this))
        .catch(function (error) {
          MessageBox.error(error.message);
        })
        .finally(function () {
          this._view.setProperty("/busy", false);
        }.bind(this));
    },

    _heatmapTexts: function () {
      var b = this._bundle;
      return {
        notAssessed: b.getText("notAssessed"),
        notCounted: b.getText("notCounted"),
        notDecided: b.getText("notDecided"),
        notApplicable: b.getText("notApplicable"),
        noRequirement: b.getText("noRequirement"),
        notDecidedHint: b.getText("notDecidedHint"),
        notApplicableHint: b.getText("notApplicableHint"),
        noRequirementHint: b.getText("noRequirementHint"),
        noPopulation: b.getText("noPopulation"),
        localTarget: b.getText("localTargetTooltip"),
        counted: b.getText("countedOn"),
        noLine: b.getText("noStockLine"),
        notVerified: b.getText("notVerified"),
        notVerifiedHint: b.getText("notVerifiedHint"),
        unconfirmed: b.getText("unconfirmed"),
        severity1: b.getText("severityCritical"),
        severity2: b.getText("severityAttention"),
        severity3: b.getText("severityMet")
      };
    },

    /** Texts that quote a planning threshold always show the values in force. */
    _showSettings: function (s) {
      var b = this._bundle;
      // the stored replenishment target: where the request preview starts (UX-05)
      this._targetDays = Number(s.targetDays);
      var n = formatter.decimal;
      this._view.setProperty("/text", {
        legendCritical: b.getText("legendCritical", [n(s.criticalDays), n(s.criticalPercent)]),
        legendWarning: b.getText("legendWarning", [n(s.warningDays), n(s.warningPercent)]),
        shortfall: b.getText("colShortfall", [n(s.targetDays)]),
        emptyGaps: b.getText("emptyGapsText", [n(s.criticalDays), n(s.criticalPercent)])
      });
      // UX-10: the tiles quote the thresholds in force
      this._view.setProperty("/kpiRule", {
        crisis: b.getText("kpiCrisisRule", [n(s.criticalDays), n(s.criticalPercent)]),
        critical: b.getText("kpiCriticalRule", [n(s.criticalDays), n(s.criticalPercent), n(s.warningDays), n(s.warningPercent)])
      });
    },

    _showOverview: function (kpi, campCount) {
      var b = this._bundle;
      var now = timeFormat.format(new Date());
      this._view.setProperty("/kpi", kpi);
      this._view.setProperty("/kpiText", {
        camps: kpi.campsNotAssessed ? b.getText("kpiCampsNotAssessed", [formatter.integer(kpi.campsNotAssessed)]) : b.getText("kpiCampsSub"),
        people: b.getText("kpiPeopleSub", [formatter.integer(kpi.childrenUnder5)]),
        crisis: b.getText("kpiCrisisSub", [formatter.integer(kpi.peopleInCrisis)]),
        critical: b.getText("kpiCriticalSub", [formatter.integer(kpi.warningGaps)])
      });
      var notes = [];
      if (kpi.campsNotAssessed) {
        notes.push(b.getText("noteNotAssessed", [formatter.integer(kpi.campsNotAssessed)]));
      }
      if (kpi.indicatorsNotCounted) {
        notes.push(b.getText("noteNotCounted", [formatter.integer(kpi.indicatorsNotCounted)]));
      }
      if (kpi.indicatorsNotVerified) {
        notes.push(b.getText("noteNotVerified", [formatter.integer(kpi.indicatorsNotVerified)]));
      }
      if (kpi.decisionsNeeded) {
        notes.push(b.getText("noteNotDecided", [formatter.integer(kpi.decisionsNeeded)]));
      }
      if (kpi.localTargetsInForce) {
        notes.push(b.getText("noteLocalTargets", [formatter.integer(kpi.localTargetsInForce), formatter.integer(kpi.campsWithLocalTargets)]));
      }
      this._view.setProperty("/subtitle", campCount
        ? b.getText("subtitle", [campCount, now, localZone()]) + notes.map(function (n) { return " · " + n; }).join("")
        : b.getText("subtitleEmpty", [now, localZone()]));
      this._view.setProperty("/snapped", b.getText("snapped", [formatter.integer(kpi.people), formatter.integer(kpi.criticalGaps)]));
    },

    /** The heatmap has one column per reference indicator, so it is built from the code list. */
    _buildHeatmapColumns: function (standards) {
      var table = this.byId("heatmap");
      var b = this._bundle;

      table.addColumn(new Column({ width: "15rem", header: new Text({ text: b.getText("colCamp") }) }));
      table.addColumn(new Column({
        hAlign: "End", width: "7rem", minScreenWidth: "Tablet", demandPopin: true,
        header: new Text({ text: b.getText("colPeople") })
      }));
      table.addColumn(new Column({
        hAlign: "Center", width: "7rem", header: new Text({ text: b.getText("colCompliance") })
      }));

      var cells = [
        new ObjectIdentifier({ title: "{view>name}", text: "{view>place}", titleActive: true, titlePress: this.onOpenCamp.bind(this) }),
        new ObjectNumber({ number: { path: "view>headcount", formatter: formatter.people } }),
        // Indicators met only means something when indicators were assessed.
        new HBox({
          justifyContent: "Center",
          renderType: "Bare",
          items: [
            new RadialMicroChart({
              size: "XS",
              percentage: "{view>compliance}",
              valueColor: { path: "view>worstSeverity", formatter: formatter.severityColor },
              alignContent: "Center",
              tooltip: "{view>compliance} %",
              visible: "{= ${view>state} === 'assessed' }"
            }),
            new ObjectStatus({
              text: "{view>stateText}",
              icon: "{= ${view>state} === 'notAssessed' ? 'sap-icon://status-inactive' : 'sap-icon://pending' }",
              visible: "{= ${view>state} !== 'assessed' }"
            })
          ]
        })
      ];

      var previousSector = null;
      standards.forEach(function (standard) {
        // UX-09: the sector is named once, above the first indicator of its group
        var sector = standard.sector ? standard.sector.name : "";
        var sectorLabel = sector !== previousSector ? sector : "";
        previousSector = sector;
        table.addColumn(new Column({
          hAlign: "Center",
          minScreenWidth: "Desktop",
          demandPopin: true,
          popinDisplay: "Inline",
          // UX-09: the sector above the indicator
          header: new VBox({ renderType: "Bare", alignItems: "Center", items: [
            new Text({ text: sectorLabel || "\u00a0", wrapping: true }).addStyleClass("rgSectorLabel"),
            new Text({ text: standard.name, tooltip: standard.unit, wrapping: true })
          ] })
        }));
        var base = "view>cells/" + standard.code + "/";
        cells.push(new ObjectStatus({
          text: "{" + base + "text}",
          state: "{" + base + "state}",
          // UX-04: an icon and a word with every colour; a local target is marked with an asterisk (B4.2)
          icon: "{" + base + "icon}",
          stateAnnouncementText: "{" + base + "word}",
          inverted: true,
          tooltip: "{" + base + "tooltip}"
        }).addStyleClass("rgCell"));
      });

      table.bindItems({
        path: "view>/camps",
        template: new ColumnListItem({ type: "Navigation", press: this.onOpenCamp.bind(this), cells: cells }),
        templateShareable: false
      });
      this._columnsBuilt = true;
    },

    /** UX-08: what to act on now, each in plain words, most urgent first. */
    _showActNow: function (items) {
      var b = this._bundle;
      var n = formatter.decimal;
      var day = function (d) { return d ? dateFormat.format(new Date(d + "T00:00:00")) : ""; };
      this._view.setProperty("/actNow", items.map(function (i) {
        var text = i.kind === "CRITICAL_GAP"
          ? (i.daysOfCover !== null && i.daysOfCover !== undefined ? b.getText("actGapDays", [i.standardName, n(i.daysOfCover)]) : b.getText("actGapPct", [i.standardName, n(i.coveragePct)]))
          : i.kind === "OVERDUE_DELIVERY"
            ? b.getText("actLate", [n(i.quantity), i.unit, i.standardName, i.donor, day(i.date)])
            : b.getText("actUnanswered", [n(i.quantity), i.unit, i.standardName, day(i.date)]);
        return Object.assign({}, i, {
          text: text,
          icon: { CRITICAL_GAP: "sap-icon://error", OVERDUE_DELIVERY: "sap-icon://shipping-status", UNANSWERED_REQUEST: "sap-icon://request" }[i.kind],
          state: i.kind === "CRITICAL_GAP" ? "Error" : "Warning",
          kindText: b.getText("act" + i.kind)
        });
      }));
    },

    onOpenActNow: function (event) {
      var i = event.getSource().getBindingContext("view").getObject();
      var route = "/Camps(ID=" + i.campID + ",IsActiveEntity=true)" + (i.requestID ? "/requests(" + i.requestID + ")" : "");
      this._navigate("ReliefCamp-manage&" + route, "../../camps/webapp/index.html#" + route);
    },

    // ---------------------------------------------------------------------
    // UX-09: filters for region, district, hazard and severity
    // ---------------------------------------------------------------------

    _fillFilters: function (camps) {
      var distinct = function (key) {
        var seen = {};
        camps.forEach(function (c) {
          var v = key === "hazard" ? (c.hazard && c.hazard.name) : c[key];
          if (v) {
            seen[v] = true;
          }
        });
        return [{ key: "", text: this._bundle.getText("filterAll") }].concat(Object.keys(seen).sort().map(function (v) { return { key: v, text: v }; }));
      }.bind(this);
      this._view.setProperty("/filterValues", { region: distinct("region"), district: distinct("district"), hazard: distinct("hazard") });
      if (!this._view.getProperty("/filter")) {
        this._view.setProperty("/filter", { region: "", district: "", hazard: "", severity: "" });
      }
      this.onFilter();
    },

    onFilter: function () {
      var f = this._view.getProperty("/filter") || {};
      var filters = [];
      ["region", "district", "hazard"].forEach(function (key) {
        if (f[key]) {
          filters.push(new Filter(key, FilterOperator.EQ, f[key]));
        }
      });
      if (f.severity) {
        filters.push(new Filter({ path: "rank", test: function (rank) {
          return { critical: rank === 1, attention: rank === 2, notCounted: rank === 3, met: rank === 4, notAssessed: rank === 5 }[f.severity];
        } }));
      }
      var binding = this.byId("heatmap").getBinding("items");
      if (binding) {
        binding.filter(filters.length ? new Filter({ filters: filters, and: true }) : []);
      }
      this._view.setProperty("/filtered", filters.length > 0);
    },

    onClearFilters: function () {
      this._view.setProperty("/filter", { region: "", district: "", hazard: "", severity: "" });
      this.onFilter();
    },

    _refreshAll: function () {
      this.byId("gaps").getBinding("items").refresh();
      this.byId("transit").getBinding("items").refresh();
      return this.load();
    },

    onRefresh: function () {
      this._refreshAll();
    },

    etaText: function (eta) {
      var b = this._bundle;
      switch (formatter.etaStatus(eta, this._today)) {
        case "none": return b.getText("etaNone");
        case "today": return b.getText("etaToday");
        case "overdue": return b.getText("etaOverdue", [dateFormat.format(new Date(eta + "T00:00:00"))]);
        default: return dateFormat.format(new Date(eta + "T00:00:00"));
      }
    },

    // ---------------------------------------------------------------------
    // Navigation (Fiori launchpad aware, with a standalone fallback)
    // ---------------------------------------------------------------------

    _navigate: function (shellHash, standalonePath) {
      var Container = sap.ui.require("sap/ushell/Container");
      if (Container) {
        return Container.getServiceAsync("Navigation").then(function (navigation) {
          return navigation.navigate({ target: { shellHash: shellHash } });
        });
      }
      window.location.href = new URL(standalonePath, window.location.href).href;
      return Promise.resolve();
    },

    onOpenCamp: function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      var route = "/Camps(ID=" + row.ID + ",IsActiveEntity=true)";
      this._navigate("ReliefCamp-manage&" + route, "../../camps/webapp/index.html#" + route);
    },

    onManageCamps: function () {
      this._navigate("ReliefCamp-manage", "../../camps/webapp/index.html");
    },

    onPledgeBoard: function () {
      this._navigate("SupplyRequest-pledge", "../../pledge/webapp/index.html");
    },

    onMethodology: function () {
      this._navigate("ReliefMethodology-display", "../../methodology/webapp/index.html");
    },

    /** Applicability items that need someone's attention, each with a plain-language label. */
    _showAttention: function (items) {
      var b = this._bundle;
      var STATE = { REQUEST_REVIEW: "Warning", PENDING: "Information", REVIEW_OVERDUE: "Warning", REVIEW_DUE: "Information", NOT_DECIDED: "None",
        SCHEDULED: "None", SCHEDULED_BLOCKED: "Error", HOUSEHOLD_SIZE_PENDING: "Information" };
      var ICON = { REQUEST_REVIEW: "sap-icon://request", PENDING: "sap-icon://pending", REVIEW_OVERDUE: "sap-icon://appointment-2",
        REVIEW_DUE: "sap-icon://appointment-2", NOT_DECIDED: "sap-icon://question-mark", SCHEDULED: "sap-icon://date-time", SCHEDULED_BLOCKED: "sap-icon://error",
        HOUSEHOLD_SIZE_PENDING: "sap-icon://group" };
      this._view.setProperty("/attention", items.map(function (i) {
        // decision items name their kind: an applicability decision, a local target or a response phase
        var key = "attn" + i.kind + ({ TARGET: "_TARGET", PHASE: "_PHASE" }[i.decisionKind] || "");
        return Object.assign({}, i, {
          label: b.getText(key, [i.date ? dateFormat.format(new Date(i.date + "T00:00:00")) : ""]),
          state: STATE[i.kind] || "None",
          icon: ICON[i.kind] || "",
          // a household-size proposal concerns every camp without a recorded household count
          campName: i.kind === "HOUSEHOLD_SIZE_PENDING" ? b.getText("attnAllCamps") : i.campName,
          standardName: i.kind === "HOUSEHOLD_SIZE_PENDING" ? b.getText("attnContainers") : i.standardName
        });
      }));
    },

    /** Local targets of active camps with their figure, the reference figure and the review state (B4.2). */
    _showTargets: function (items) {
      var b = this._bundle;
      var figure = function (value, i) {
        return value === null || value === undefined ? "–"
          : b.getText(i.basis === "Consumption" ? "figurePerDay" : "figure", [formatter.decimal(Number(value)), i.unit]);
      };
      this._view.setProperty("/targets", items.map(function (i) {
        var ended = i.status === "SUPERSEDED" || i.status === "WITHDRAWN";
        var review = i.reviewState === "OVERDUE" ? "Warning" : i.reviewState === "DUE_TODAY" ? "Information" : null;
        return Object.assign({}, i, {
          valueText: i.intent === "WITHDRAW" ? b.getText("targetWithdrawal") : figure(i.targetPerPerson, i),
          referenceText: figure(i.referencePerPerson, i),
          state: review || (i.status === "APPROVED" ? "Success" : ended ? "None" : "Information"),
          icon: review ? "sap-icon://appointment-2" : i.status === "APPROVED" ? "sap-icon://sys-enter-2" : ended ? "sap-icon://history" : "sap-icon://pending",
          reviewText: i.reviewDue ? dateFormat.format(new Date(i.reviewDue + "T00:00:00")) : (i.status === "APPROVED" ? b.getText("reviewChangeProposed") : "")
        });
      }));
    },

    onOpenTarget: function (event) {
      var i = event.getSource().getBindingContext("view").getObject();
      var route = "/Camps(ID=" + i.campID + ",IsActiveEntity=true)/decisions(" + i.decisionID + ")";
      this._navigate("ReliefCamp-manage&" + route, "../../camps/webapp/index.html#" + route);
    },

    onOpenAttention: function (event) {
      var i = event.getSource().getBindingContext("view").getObject();
      if (i.kind === "HOUSEHOLD_SIZE_PENDING") {
        this._navigate("ReliefMethodology-display", "../../methodology/webapp/index.html");
        return;
      }
      var camp = "/Camps(ID=" + i.campID + ",IsActiveEntity=true)";
      var route = camp + (i.decisionID ? "/decisions(" + i.decisionID + ")" : i.requestID ? "/requests(" + i.requestID + ")" : "");
      this._navigate("ReliefCamp-manage&" + route, "../../camps/webapp/index.html#" + route);
    },

    onKpiPress: function (event) {
      var tab = event.getSource().data("tab");
      this._view.setProperty("/tab", tab || "heatmap");
    },

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    onRaiseRequests: function (event) {
      var stock = event.getSource().getBindingContext();
      var camp = stock.getObject("camp");
      var model = this.getOwnerComponent().getModel();
      // UX-05: every request is reviewed before it is published to donors
      sap.ui.require(["reliefgrid/shared/RaisePreview"], function (RaisePreview) {
        RaisePreview.open({ model: model, campID: camp.ID, campName: camp.name, targetDays: this._targetDays })
          .then(function (choice) {
            if (choice) {
              this._publishRequests(model, camp, choice.targetDays);
            }
          }.bind(this))
          .catch(this._showError.bind(this));
      }.bind(this));
    },

    _publishRequests: function (model, camp, targetDays) {
      var action = model.bindContext("/Camps(ID=" + camp.ID + ",IsActiveEntity=true)/ReliefService.raiseRequests(...)");
      action.setParameter("targetDays", targetDays);
      this._view.setProperty("/busy", true);
      var b = this._bundle;
      action.invoke()
        .then(function () {
          // The counts of this very operation; lines never counted are skipped, and then the result is partial.
          var result = action.getBoundContext().getObject();
          var created = result.created || 0;
          var skipped = result.skipped || 0;
          // toilet and tap lines whose functionality is not confirmed are skipped too (B4.5)
          var unverified = result.notVerified || 0;
          if (result.notAssessed) {
            MessageBox.warning(b.getText("raisedNotAssessed", [camp.name]), { title: b.getText("raisedNoneTitle") });
          } else if (skipped || unverified) {
            MessageBox.warning(
              (created ? b.getText("raisedSome", [camp.name, created]) : b.getText("raisedNone", [camp.name])) +
                (skipped ? "\n\n" + b.getText("skippedNotCounted", [skipped]) : "") +
                (unverified ? "\n\n" + b.getText("skippedNotVerified", [unverified]) : ""),
              { title: b.getText(created ? "raisedPartlyTitle" : "raisedNoneTitle") });
          } else {
            MessageToast.show(created ? b.getText("toastRaised", [created]) : b.getText("toastNothing", [camp.name]));
          }
          return this._refreshAll();
        }.bind(this))
        .catch(this._showError.bind(this));
    },

    /**
     * UX-06 with ARCH-02, ARCH-03: one arrival of goods, as received and as accepted (usable), with its
     * condition and, for damaged or rejected goods, more than pledged or a pledge closed short, a reason.
     */
    onConfirmDelivery: function (event) {
      var pledge = event.getSource().getBindingContext();
      var p = pledge.getObject();
      var b = this._bundle;
      var unit = p.request.standard.unit;
      var remaining = Math.max(0, Number(p.quantity) - Number(p.receivedQuantity || 0));
      var form = new JSONModel({ received: remaining, accepted: remaining, condition: "GOOD", reason: "", close: false });
      var number = function (path, min) {
        return new StepInput({ value: "{form>" + path + "}", min: min, step: 1, displayValuePrecision: 0, width: "100%", description: unit, fieldWidth: "70%" });
      };
      var received = number("/received", 0);
      var accepted = number("/accepted", 0);
      var condition = new Select({ selectedKey: "{form>/condition}", width: "100%", items: [
        new Item({ key: "GOOD", text: b.getText("conditionGood") }),
        new Item({ key: "DAMAGED", text: b.getText("conditionDamaged") }),
        new Item({ key: "REJECTED", text: b.getText("conditionRejected") })
      ] });
      var reason = new TextArea({ value: "{form>/reason}", rows: 2, maxLength: 500, width: "100%", growing: true });
      var close = new CheckBox({ selected: "{form>/close}", text: b.getText("receiptClose"), wrapping: true });
      // a reason is needed for damaged or rejected goods, for more than pledged, and for closing a pledge short
      var why = function () {
        var f = form.getData();
        var total = Number(p.receivedQuantity || 0) + Number(f.received);
        return f.condition !== "GOOD" || Number(f.accepted) < Number(f.received) || total > Number(p.quantity) || (f.close && total < Number(p.quantity));
      };
      received.attachChange(function () {
        if (Number(form.getProperty("/accepted")) > Number(form.getProperty("/received")) || form.getProperty("/condition") === "GOOD") {
          form.setProperty("/accepted", form.getProperty("/received"));
        }
      });
      var dialog = new Dialog({
        title: b.getText("confirmTitle"),
        contentWidth: "32rem",
        content: new VBox({
          items: [
            new Text({
              text: b.getText("confirmText", [p.donor, formatter.decimal(p.quantity), unit, p.request.standard.name, p.request.camp.name]) +
                (Number(p.receivedQuantity) ? " " + b.getText("confirmSoFar", [formatter.decimal(p.receivedQuantity), unit]) : "")
            }).addStyleClass("sapUiSmallMarginBottom"),
            new Label({ text: b.getText("confirmReceived"), labelFor: received, required: true }), received,
            new Label({ text: b.getText("confirmAccepted"), labelFor: accepted, required: true }).addStyleClass("sapUiSmallMarginTop"), accepted,
            new Label({ text: b.getText("receiptCondition"), labelFor: condition }).addStyleClass("sapUiSmallMarginTop"), condition,
            new Label({ text: b.getText("receiptReason"), labelFor: reason }).addStyleClass("sapUiSmallMarginTop"), reason,
            close,
            new Text({ text: b.getText("confirmHint") }).addStyleClass("sapUiTinyMarginTop rgHint")
          ]
        }).addStyleClass("sapUiSmallMargin"),
        beginButton: new Button({
          text: b.getText("confirm"),
          type: "Emphasized",
          press: function () {
            var f = form.getData();
            if (Number(f.accepted) > Number(f.received)) {
              accepted.setValueState("Error").setValueStateText(b.getText("acceptedTooHigh"));
              return;
            }
            if (why() && !String(f.reason).trim()) {
              reason.setValueState("Error").setValueStateText(b.getText("receiptReasonNeeded"));
              return;
            }
            dialog.close();
            this._invokePledgeAction(pledge, "confirmDelivery", {
              receivedQuantity: Number(f.received), acceptedQuantity: Number(f.accepted),
              condition: Number(f.accepted) < Number(f.received) && f.condition === "GOOD" ? "DAMAGED" : f.condition,
              reason: String(f.reason).trim() || null, closePledge: !!f.close
            }, "toastDelivered");
          }.bind(this)
        }),
        endButton: new Button({ text: b.getText("cancel"), press: function () { dialog.close(); } }),
        afterClose: function () { dialog.destroy(); }
      });
      dialog.setModel(form, "form");
      this.getView().addDependent(dialog);
      dialog.open();
    },

    onWithdraw: function (event) {
      var pledge = event.getSource().getBindingContext();
      MessageBox.confirm(this._bundle.getText("withdrawConfirm", [pledge.getProperty("donor")]), {
        emphasizedAction: MessageBox.Action.OK,
        onClose: function (action) {
          if (action === MessageBox.Action.OK) {
            this._invokePledgeAction(pledge, "withdraw", {}, "toastWithdrawn");
          }
        }.bind(this)
      });
    },

    _invokePledgeAction: function (pledge, name, parameters, toast) {
      var action = this.getOwnerComponent().getModel()
        .bindContext("/Pledges(" + pledge.getProperty("ID") + ")/ReliefService." + name + "(...)");
      Object.keys(parameters).forEach(function (key) {
        action.setParameter(key, parameters[key]);
      });
      this._view.setProperty("/busy", true);
      action.invoke()
        .then(function () {
          MessageToast.show(this._bundle.getText(toast));
          return this._refreshAll();
        }.bind(this))
        .catch(this._showError.bind(this));
    },

    _showError: function (error) {
      this._view.setProperty("/busy", false);
      MessageBox.error(error.message);
    }
  });
});
