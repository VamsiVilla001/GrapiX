import { MaterialManagerPanel } from "../modules/material-manager";

/** Legacy workbench entry point retained so older layouts use the central Material Manager. */
export function AssetMaterialPanel() {
  return <MaterialManagerPanel />;
}
