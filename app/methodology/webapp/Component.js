sap.ui.define(["sap/ui/core/UIComponent", "sap/ui/Device"], function (UIComponent, Device) {
  "use strict";

  return UIComponent.extend("reliefgrid.methodology.Component", {
    metadata: {
      manifest: "json",
      interfaces: ["sap.ui.core.IAsyncContentCreation"]
    },

    getContentDensityClass: function () {
      return Device.support.touch ? "sapUiSizeCozy" : "sapUiSizeCompact";
    }
  });
});
