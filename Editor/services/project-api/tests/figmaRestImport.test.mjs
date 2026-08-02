import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DESIGN_IMPORT_OPTIONS } from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import {
  importFigmaRestDocument,
  normalizeFigmaNodeId,
  parseFigmaLink
} from "../dist/importers/design/figmaRestImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import { createDesignImportReport } from "../dist/importers/design/importReport.js";

test("every Figma link flavour yields the file key and node ids the REST API takes", () => {
  assert.deepEqual(
    parseFigmaLink("https://www.figma.com/design/abc123DEF456ghi789JK/Broadcast-Kit?node-id=94-13013&t=xyz"),
    { fileKey: "abc123DEF456ghi789JK", branchKey: undefined, nodeIds: ["94:13013"], kind: "design" }
  );

  // Legacy /file links, and an already-colon-form id that arrived percent-encoded.
  assert.deepEqual(
    parseFigmaLink("https://www.figma.com/file/abc123DEF456ghi789JK/Kit?node-id=1%3A2").nodeIds,
    ["1:2"]
  );

  // A branch is addressed as its own file, so the branch key wins.
  const branch = parseFigmaLink("https://www.figma.com/design/PARENTkey0000000000/branch/BRANCHkey000000000/Kit?node-id=5-6");
  assert.equal(branch.fileKey, "BRANCHkey000000000");
  assert.equal(branch.branchKey, "BRANCHkey000000000");

  // Prototype and FigJam links carry the key in the same slot.
  assert.equal(parseFigmaLink("https://www.figma.com/proto/abc123DEF456ghi789JK/Kit?node-id=7-8").kind, "proto");
  assert.equal(parseFigmaLink("https://www.figma.com/board/abc123DEF456ghi789JK/Jam").kind, "board");

  // Several nodes in one link, plus an instance id.
  assert.deepEqual(
    parseFigmaLink("https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=1-2,I3-4;5-6").nodeIds,
    ["1:2", "I3:4;5:6"]
  );

  // A bare key is accepted; a link with no node-id means the whole file.
  assert.deepEqual(parseFigmaLink("abc123DEF456ghi789JK"), { fileKey: "abc123DEF456ghi789JK", nodeIds: [], kind: "key" });
  assert.deepEqual(parseFigmaLink("https://www.figma.com/design/abc123DEF456ghi789JK/Kit").nodeIds, []);

  assert.throws(() => parseFigmaLink("https://example.com/not-figma"), /not a Figma link/);
  assert.throws(() => parseFigmaLink("   "), /required/);
  assert.equal(normalizeFigmaNodeId("garbage"), null);
});

/** A REST /nodes response: a frame with editable text, a vector with geometry, and an image fill. */
function restNodesResponse() {
  return {
    name: "Broadcast Kit",
    nodes: {
      "94:13013": {
        document: {
          id: "94:13013",
          name: "Team Reveal",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
          fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0, b: 0.2, a: 1 } }],
          layoutMode: "HORIZONTAL",
          children: [
            {
              id: "94:13014",
              name: "Team Name",
              type: "TEXT",
              absoluteBoundingBox: { x: 80, y: 120, width: 600, height: 90 },
              characters: "WOLFRAHH",
              style: { fontFamily: "Saira Condensed", fontWeight: 600, fontSize: 72, lineHeightPx: 80, letterSpacing: 2, textAlignHorizontal: "LEFT" },
              fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }]
            },
            {
              id: "94:13015",
              name: "Chevron",
              type: "VECTOR",
              absoluteBoundingBox: { x: 80, y: 240, width: 200, height: 100 },
              fillGeometry: [{ path: "M0 0 L200 0 L100 100 Z" }],
              fills: [{ type: "SOLID", visible: true, color: { r: 0.96, g: 0.32, b: 0.12, a: 1 } }],
              strokes: []
            },
            {
              id: "94:13016",
              name: "Hero",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 900, y: 0, width: 1020, height: 1080 },
              fills: [{ type: "IMAGE", visible: true, imageRef: "ref-hero", scaleMode: "FILL" }]
            }
          ]
        },
        components: { "component-key": { name: "Score Card", node_id: "94:13020" } },
        componentSets: {}
      }
    }
  };
}

function stubFetch(handlers) {
  return async (url, init) => {
    const target = String(url);
    for (const [fragment, respond] of Object.entries(handlers)) {
      if (target.includes(fragment)) return respond(target, init);
    }
    throw new Error(`unexpected request ${target}`);
  };
}

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});

test("REST import converts native document JSON into editable objects, not a screenshot", async () => {
  const seen = [];
  const fetchImpl = stubFetch({
    "/nodes?": (url, init) => {
      seen.push({ url, token: init.headers["X-Figma-Token"] ?? init.headers.Authorization });
      return jsonResponse(restNodesResponse());
    },
    "/images": () => jsonResponse({ error: false, meta: { images: { "ref-hero": "https://figma-alpha-api.s3.amazonaws.com/images/hero.png" } } })
  });

  const report = createDesignImportReport("figma-json", "rest");
  const document = await importFigmaRestDocument(
    { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=94-13013", accessToken: "figd_test-token" },
    report,
    { fetchImpl }
  );
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(document, DEFAULT_DESIGN_IMPORT_OPTIONS),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );

  // The request carried the personal-token header and asked for vector outlines.
  assert.equal(seen[0].token, "figd_test-token");
  assert.match(seen[0].url, /geometry=paths/);
  assert.match(seen[0].url, /ids=94%3A13013/);

  assert.equal(document.sourceFormat, "figma-json");
  assert.equal(document.sourceId, "abc123DEF456ghi789JK");
  assert.equal(scene.canvas.width, 1920);
  assert.equal(scene.canvas.height, 1080);

  const text = scene.objects.find((object) => object.name === "Team Name");
  assert.equal(text.type, "text", "REST text must stay editable text");
  assert.equal(text.text, "WOLFRAHH");
  assert.equal(text.fontFamily, "Saira Condensed");

  const vector = scene.objects.find((object) => object.name === "Chevron");
  assert.equal(vector.type, "shape", "REST vectors must stay editable paths");
  assert.ok(vector.path.vertices.length >= 3);

  // An image fill resolves through /v1/files/:key/images, keyed by imageRef.
  const hero = document.pages[0].nodes[0].children.find((node) => node.name === "Hero");
  const heroAsset = document.assets.find((asset) => asset.id === hero.assetId);
  assert.equal(heroAsset.sourceUrl, "https://figma-alpha-api.s3.amazonaws.com/images/hero.png");

  assert.deepEqual(report.rasterizedObjects, [], "nothing is rasterized on the REST route");
  assert.equal(document.components["component-key"].name, "Score Card");
});

test("REST import reports the nodes Figma withheld and refuses a response with none", async () => {
  const partial = restNodesResponse();
  const fetchImpl = stubFetch({
    "/nodes?": () => jsonResponse(partial),
    "/images": () => jsonResponse({ meta: { images: {} } })
  });
  const report = createDesignImportReport("figma-json", "rest");
  await importFigmaRestDocument(
    { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=94-13013,7-8", accessToken: "figd_test-token" },
    report,
    { fetchImpl }
  );
  assert.ok(report.warnings.some((message) => message.includes("no node 7:8")));

  const empty = stubFetch({ "/nodes?": () => jsonResponse({ nodes: {} }) });
  await assert.rejects(
    importFigmaRestDocument(
      { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=1-2", accessToken: "figd_test-token" },
      createDesignImportReport("figma-json", "rest"),
      { fetchImpl: empty }
    ),
    /returned none of the requested nodes/
  );
});

test("REST failures name what the operator has to change", async () => {
  const cases = [
    [401, /invalid or expired/],
    [403, /file_content:read/],
    [404, /branch link/],
    [429, /rate-limited/]
  ];
  for (const [status, expected] of cases) {
    await assert.rejects(
      importFigmaRestDocument(
        { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=1-2", accessToken: "figd_test-token" },
        createDesignImportReport("figma-json", "rest"),
        { fetchImpl: stubFetch({ "/nodes?": () => jsonResponse({ err: "nope" }, status, { "retry-after": "30" }) }) }
      ),
      expected
    );
  }

  // No token at all is a configuration problem, stated as one.
  const previous = { access: process.env.FIGMA_ACCESS_TOKEN, plain: process.env.FIGMA_TOKEN };
  delete process.env.FIGMA_ACCESS_TOKEN;
  delete process.env.FIGMA_TOKEN;
  try {
    await assert.rejects(
      importFigmaRestDocument(
        { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=1-2" },
        createDesignImportReport("figma-json", "rest"),
        { fetchImpl: stubFetch({}) }
      ),
      /file_content:read scope/
    );

  } finally {
    if (previous.access) process.env.FIGMA_ACCESS_TOKEN = previous.access;
    if (previous.plain) process.env.FIGMA_TOKEN = previous.plain;
  }
});

test("an image fill missing from the file's image map is recovered by rendering the node", async () => {
  const requested = [];
  const fetchImpl = stubFetch({
    "/nodes?": () => jsonResponse(restNodesResponse()),
    // The fill lives in a library component, so this file's map does not carry the ref.
    "/files/abc123DEF456ghi789JK/images": () => jsonResponse({ error: false, meta: { images: {} } }),
    "/v1/images/": (url) => {
      requested.push(url);
      return jsonResponse({ err: null, images: { "94:13016": "https://figma-alpha-api.s3.amazonaws.com/images/rendered-hero.png" } });
    }
  });

  const report = createDesignImportReport("figma-json", "rest");
  const document = await importFigmaRestDocument(
    { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=94-13013", accessToken: "figd_test-token" },
    report,
    { fetchImpl }
  );

  // One batched render request for the nodes whose fills could not be resolved.
  assert.equal(requested.length, 1);
  assert.match(requested[0], /ids=94%3A13016/);
  assert.match(requested[0], /format=png/);

  const hero = document.pages[0].nodes[0].children.find((node) => node.name === "Hero");
  const heroAsset = document.assets.find((asset) => asset.id === hero.assetId);
  assert.equal(heroAsset.sourceUrl, "https://figma-alpha-api.s3.amazonaws.com/images/rendered-hero.png");
  // Pixels instead of the original fill is a fidelity change, so it is reported.
  assert.deepEqual(report.rasterizedObjects, ["Hero"]);
});

test("an OAuth token is sent as a bearer, and image-fill failures cost fills but not the import", async () => {
  let authorization = null;
  const fetchImpl = stubFetch({
    "/nodes?": (url, init) => {
      authorization = init.headers.Authorization;
      return jsonResponse(restNodesResponse());
    },
    "/images": () => jsonResponse({ err: "forbidden" }, 403)
  });

  const report = createDesignImportReport("figma-json", "rest");
  const document = await importFigmaRestDocument(
    { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=94-13013", accessToken: "oauth-opaque-token" },
    report,
    { fetchImpl }
  );

  assert.equal(authorization, "Bearer oauth-opaque-token");
  const hero = document.pages[0].nodes[0].children.find((node) => node.name === "Hero");
  const heroAsset = document.assets.find((asset) => asset.id === hero.assetId);
  assert.equal(heroAsset.sourceUrl, undefined, "no URL, so the fill is reported missing rather than invented");
  assert.ok(report.missingLinkedAssets.length > 0);
});
