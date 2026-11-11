sap.ui.define(["sap/ui/core/UIComponent", "sap/ui/Device"], function (UIComponent, Device) {
  "use strict";

  // Modules shared by the apps (app/shared), found next to the apps both standalone and in the launchpad
  sap.ui.loader.config({ paths: { "reliefgrid/shared": sap.ui.require.toUrl("reliefgrid/command") + "/../../shared" } });

  return UIComponent.extend("reliefgrid.command.Component", {
    metadata: {
      manifest: "json",
      interfaces: ["sap.ui.core.IAsyncContentCreation"]
    },

    getContentDensityClass: function () {
      return Device.support.touch ? "sapUiSizeCozy" : "sapUiSizeCompact";
    }
  });
});
