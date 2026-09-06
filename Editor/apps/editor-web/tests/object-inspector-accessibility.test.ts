import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InspectorDisclosureToggle } from "../src/modules/object-inspector/components/InspectorDisclosureToggle";
import { ObjectInspectorTabStrip } from "../src/modules/object-inspector/components/ObjectInspectorTabStrip";
import { useObjectInspectorStore } from "../src/modules/object-inspector/stores/objectInspectorStore";

function count(markup: string, pattern: RegExp): number {
  return [...markup.matchAll(pattern)].length;
}

test("the selected Inspector tab is the strip's only tab stop and labels its panel", () => {
  const markup = renderToStaticMarkup(createElement(
    ObjectInspectorTabStrip,
    {
      activeTab: "Text",
      label: "Object Inspector sections",
      onSelect: () => {},
      tabs: ["Text", "Transform", "Materials", "Data Binding"]
    },
    createElement("label", null, "Name", createElement("input", { defaultValue: "Caption" }))
  ));

  assert.equal(count(markup, /role="tab"/g), 4);
  assert.equal(count(markup, /aria-selected="true"/g), 1);
  assert.equal(count(markup, /aria-selected="false"/g), 3);
  assert.equal(count(markup, /tabindex="0"/g), 1);
  assert.equal(count(markup, /tabindex="-1"/g), 3);
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /aria-label="Object Inspector sections"/);
  assert.match(markup, /role="tabpanel"/);

  const selected = markup.match(/<button aria-controls="([^"]+)" aria-selected="true"[^>]*id="([^"]+)"[^>]*>/);
  assert.ok(selected, "selected tab markup should expose its control and id");
  assert.match(markup, new RegExp(`aria-labelledby="${selected[2]}"[^>]*id="${selected[1]}"[^>]*role="tabpanel"`));

  const tabStop = markup.indexOf('tabindex="0"');
  const firstField = markup.indexOf('<input');
  assert.ok(tabStop >= 0 && firstField > tabStop, "native Tab should leave the selected tab for the first field in DOM order");
});

test("advanced disclosure state survives remounts and its control never claims focus", () => {
  useObjectInspectorStore.setState({ collapsedDisclosures: ["masks"] });
  const renderMasks = () => renderToStaticMarkup(createElement(InspectorDisclosureToggle, {
    contentId: "inspector-masks-content",
    expanded: !useObjectInspectorStore.getState().collapsedDisclosures.includes("masks"),
    headingId: "inspector-masks-heading",
    label: "Masks",
    onToggle: () => useObjectInspectorStore.getState().toggleDisclosure("masks")
  }));

  const firstMount = renderMasks();
  const secondMount = renderMasks();
  for (const markup of [firstMount, secondMount]) {
    assert.match(markup, /aria-controls="inspector-masks-content" aria-expanded="false"/);
    assert.match(markup, /id="inspector-masks-heading"/);
    assert.doesNotMatch(markup, /autofocus/i);
  }
  assert.deepEqual(useObjectInspectorStore.getState().collapsedDisclosures, ["masks"]);

  useObjectInspectorStore.getState().toggleDisclosure("masks");
  assert.match(renderMasks(), /aria-expanded="true"/);
});

test("Imported Design and Masks are the only session-scoped disclosure identities", () => {
  useObjectInspectorStore.setState({ collapsedDisclosures: [] });
  useObjectInspectorStore.getState().setDisclosureExpanded("imported-design", false);
  useObjectInspectorStore.getState().setDisclosureExpanded("masks", false);
  assert.deepEqual(useObjectInspectorStore.getState().collapsedDisclosures, ["imported-design", "masks"]);
  useObjectInspectorStore.getState().setDisclosureExpanded("imported-design", true);
  assert.deepEqual(useObjectInspectorStore.getState().collapsedDisclosures, ["masks"]);
});
