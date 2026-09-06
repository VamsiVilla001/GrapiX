import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";


test("AE runtime container creation is not reachable from Editor menus before CB3 admission", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  });
  // The component's store reads localStorage at module initialization, so this test must install
  // the browser seam before loading the known module.
  const { MenuBar } = await import("../src/components/MenuBar");

  for (const menu of ["File", "Project"]) {
    const markup = renderToStaticMarkup(createElement(MenuBar, { initialOpenMenu: menu }));
    assert.doesNotMatch(markup, /Create AE Runtime Container/);
  }
});
