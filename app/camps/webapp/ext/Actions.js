/**
 * Custom actions of Manage Relief Camps.
 * UX-05: Review and Publish Requests shows what would be published (app/shared/RaisePreview)
 * and then publishes through the service's raiseRequests action, so Fiori elements shows
 * the service's own result messages as before.
 */
sap.ui.define(["sap/m/MessageBox"], function (MessageBox) {
  "use strict";

  function review(extension, context) {
    if (!context) {
      return;
    }
    var model = context.getModel();
    return context.requestObject().then(function (camp) {
      return new Promise(function (resolve) {
        sap.ui.require(["reliefgrid/shared/RaisePreview"], resolve);
      }).then(function (RaisePreview) {
        return model.bindContext("/PlanningSettings('CURRENT')").requestObject().catch(function () { return {}; }).then(function (settings) {
          return RaisePreview.open({ model: model, campID: camp.ID, campName: camp.name, targetDays: Number(settings.targetDays) || 7 });
        });
      }).then(function (choice) {
        if (!choice) {
          return;
        }
        return extension.editFlow.invokeAction("ReliefService.raiseRequests", {
          contexts: [context],
          parameterValues: [{ name: "targetDays", value: choice.targetDays }],
          skipParameterDialog: true
        });
      });
    }).catch(function (error) {
      MessageBox.error(error.message);
    });
  }

  return {
    /** Object page header: the camp on display. */
    reviewRequests: function (context) {
      return review(this, context || this.getBindingContext());
    },
    /** List report: the one selected camp. */
    reviewRequestsForSelected: function (context, selected) {
      return review(this, (selected || [])[0]);
    }
  };
});
