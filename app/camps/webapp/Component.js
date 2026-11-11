sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";

  // Modules shared by the apps (app/shared), found next to the apps both standalone and in the launchpad
  sap.ui.loader.config({ paths: { "reliefgrid/shared": sap.ui.require.toUrl("reliefgrid/camps") + "/../../shared" } });

  return AppComponent.extend("reliefgrid.camps.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
