/**
 * The Adobe gateway stays out of this test: its contract with the model is the
 * registered import tool and the explicit storage boundary, not a live socket.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { adobeTools } from "../dist/tools/adobe.js";

test("Adobe import is registered as an import tool with an explicit storage boundary", () => {
  const registrations = [];
  const server = {
    registerTool(name, definition) {
      registrations.push({ name, definition });
    }
  };

  for (const tool of adobeTools) tool.register(server, {});

  const adobeImport = registrations.find(({ name }) => name === "grapix_editor_import_from_adobe");
  assert.ok(adobeImport, "Adobe import tool was not registered");
  assert.equal(adobeImport.definition.annotations.readOnlyHint, false, "Adobe import is not declared as a write");
  assert.match(adobeImport.definition.description, /not yet a stored scene/i);
});
