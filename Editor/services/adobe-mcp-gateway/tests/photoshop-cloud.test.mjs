import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { AdobeGateway } from "../dist/gateway.js";
import { manifestToImportDocument } from "../dist/photoshopApi.js";
import { AdobeClient } from "@grapix/adobe-client";

const TOKEN = "cloud-token-abcdef";

const CREDENTIALS = {
  clientId: "test-client",
  clientSecret: "test-secret",
  orgId: "test-org@AdobeOrg",
  scopes: ["openid"]
};

/**
 * A stand-in for Adobe's Photoshop API. Real credentials and a network round trip are not
 * available in this repository, so the SDK *client contract* is faked while everything
 * above it — routing, transport selection, manifest conversion, error mapping — is real.
 */
function fakePhotoshopApi(overrides = {}) {
  const calls = [];
  const client = {
    getDocumentManifest: async (input, options) => {
      calls.push(["getDocumentManifest", input, options]);
      return {
        jobId: "job-1",
        outputs: [
          {
            status: "succeeded",
            document: { name: "Election.psd", width: 1920, height: 1080 },
            layer: [
              {
                id: 3,
                name: "Headline",
                type: "textLayer",
                bounds: { top: 800, left: 120, width: 900, height: 90 },
                blendOptions: { opacity: 100, blendMode: "normal" },
                text: {
                  content: "BREAKING NEWS",
                  characterStyles: [{ fontSize: 64, fontName: "Inter-Bold" }],
                  paragraphStyles: [{ alignment: "justifyLeft" }]
                }
              },
              {
                id: 4,
                name: "Glow",
                type: "layer",
                visible: false,
                blendOptions: { opacity: 50, blendMode: "colorDodge" }
              },
              {
                id: 5,
                name: "Grade",
                type: "adjustmentLayer",
                blendOptions: { opacity: 100, blendMode: "normal" }
              },
              {
                id: 6,
                name: "Group",
                type: "layerSection",
                blendOptions: { opacity: 100, blendMode: "normal" },
                children: [
                  { id: 7, name: "Logo", type: "smartObject", blendOptions: { opacity: 100, blendMode: "multiply" } }
                ]
              },
              {
                id: 8,
                name: "Background",
                type: "layer",
                blendOptions: { opacity: 100, blendMode: "normal" }
              }
            ]
          }
        ]
      };
    },
    createRendition: async (input, outputs) => {
      calls.push(["createRendition", input, outputs]);
      return {
        jobId: "job-2",
        outputs: [
          {
            status: "succeeded",
            _links: {
              renditions: [
                { href: "https://renditions.example.test/Election-preview.png", type: "image/png" },
                {
                  href: "https://renditions.example.test/Election-Glow.png",
                  type: "image/png",
                  layers: [{ id: 4 }]
                }
              ]
            }
          }
        ]
      };
    },
    modifyDocument: async (input, outputs, options) => {
      calls.push(["modifyDocument", input, outputs, options]);
      return { jobId: "job-3", outputs: [{ status: "succeeded" }] };
    },
    replaceSmartObject: async (input, outputs, options) => {
      calls.push(["replaceSmartObject", input, outputs, options]);
      return { jobId: "job-4", outputs: [{ status: "succeeded" }] };
    },
    createDocument: async (outputs, options) => {
      calls.push(["createDocument", outputs, options]);
      return { jobId: "job-5", outputs: [{ status: "succeeded" }] };
    },
    ...overrides
  };
  return { client, calls };
}

async function startGateway({ withCloud = true, api = fakePhotoshopApi() } = {}) {
  const gateway = new AdobeGateway(
    {
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      allowPublic: false,
      photoshopApi: withCloud ? CREDENTIALS : undefined
    },
    async () => api.client
  );
  const port = await gateway.listen();
  return { gateway, api, url: `ws://127.0.0.1:${port}` };
}

function makeClient(url) {
  return new AdobeClient({
    url,
    token: TOKEN,
    autoReconnect: false,
    callTimeoutMs: 5_000,
    webSocketImpl: WebSocket
  });
}

function connectBridge(url, app, handlers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", role: "bridge", token: TOKEN, app, appVersion: "26.4.0" }));
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello.ack") return resolve({ socket, peerId: message.peerId });
      if (message.type !== "tool.call") return;
      const handler = handlers[message.tool];
      const result = handler ? await handler(message.arguments ?? {}) : { servedBy: "local" };
      socket.send(JSON.stringify({ type: "tool.result", requestId: message.requestId, ok: true, result }));
    });
    socket.on("error", reject);
  });
}

test("configuring the Photoshop API makes Photoshop usable with no local plugin", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const status = await client.discover();

    assert.equal(status.applications.photoshop.connected, false, "no plugin is running");
    assert.equal(status.applications.photoshop.cloudAvailable, true);
    assert.equal(status.applications["after-effects"].cloudAvailable, false);
    assert.match(status.applications["after-effects"].cloudDetail ?? "", /no cloud API/);
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("an unconfigured Photoshop API names the environment variables it needs", async () => {
  const { gateway, url } = await startGateway({ withCloud: false });
  const client = makeClient(url);
  try {
    await client.connect();
    const status = await client.discover();
    assert.equal(status.applications.photoshop.cloudAvailable, false);
    assert.match(status.applications.photoshop.cloudDetail ?? "", /GRAPIX_PS_API_CLIENT_ID/);

    await assert.rejects(
      () => client.call("photoshop.getDocumentStructure", { href: "https://example.test/a.psd" }),
      (error) => error.code === "bridge_unavailable"
    );
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("reading a document structure over the cloud converts Adobe's manifest to GrapiX layers", async () => {
  const { gateway, api, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const document = await client.call("photoshop.getDocumentStructure", {
      href: "https://example.test/Election.psd"
    });

    assert.equal(document.source, "photoshop");
    assert.equal(document.name, "Election.psd");
    assert.equal(document.width, 1920);

    const [headline, glow, grade, group] = document.layers;
    assert.equal(headline.type, "text");
    assert.equal(headline.textData.text, "BREAKING NEWS");
    assert.equal(headline.textData.fontSize, 64);
    assert.equal(headline.textData.align, "justify", "justifyLeft maps to GrapiX justify");
    assert.equal(headline.transform.x, 120);
    assert.equal(headline.transform.y, 800);

    assert.equal(glow.visible, false);
    assert.equal(glow.opacity, 0.5, "Photoshop reports 0-100; GrapiX uses 0-1");

    assert.equal(grade.type, "adjustment");
    assert.equal(grade.status, "Rasterised");

    assert.equal(group.type, "group");
    assert.equal(group.children[0].type, "smart-object");
    assert.equal(group.children[0].parentId, "6");

    assert.equal(glow.assetId, "layer-4");
    assert.deepEqual(
      document.assets.find((asset) => asset.id === "layer-4"),
      {
        id: "layer-4",
        name: "Glow.png",
        kind: "image",
        mimeType: "image/png",
        url: "https://renditions.example.test/Election-Glow.png"
      }
    );
    assert.equal(
      document.assets.find((asset) => asset.id === "preview")?.url,
      "https://renditions.example.test/Election-preview.png"
    );
    const missingRendition = document.warnings.find((entry) => entry.layerId === "8" && entry.code === "photoshop.rendition.layer");
    assert.ok(missingRendition, "a pixel layer without an Adobe rendition must be reported");
    assert.match(missingRendition.message, /Background/);

    assert.deepEqual(api.calls[1], [
      "createRendition",
      { href: "https://example.test/Election.psd", storage: "external" },
      [
        {
          href: "/files/GrapiX/$ReqID/preview.png",
          storage: "adobe",
          type: "image/png",
          trimToCanvas: "true"
        },
        {
          href: "/files/GrapiX/$ReqID/layer-4.png",
          storage: "adobe",
          type: "image/png",
          trimToCanvas: "false",
          layers: [{ id: 4 }]
        },
        {
          href: "/files/GrapiX/$ReqID/layer-8.png",
          storage: "adobe",
          type: "image/png",
          trimToCanvas: "false",
          layers: [{ id: 8 }]
        }
      ]
    ]);

    assert.deepEqual(api.calls[0], [
      "getDocumentManifest",
      { href: "https://example.test/Election.psd", storage: "external" },
      { thumbnails: { type: "image/png" } }
    ]);
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a Photoshop blend mode GrapiX cannot draw is reported, never silently aliased", () => {
  const document = manifestToImportDocument(
    {
      status: "succeeded",
      document: { name: "a.psd", width: 10, height: 10 },
      layers: [
        { id: 1, name: "Burned", type: "layer", blendOptions: { opacity: 100, blendMode: "colorBurn" } },
        { id: 2, name: "Screened", type: "layer", blendOptions: { opacity: 100, blendMode: "screen" } }
      ]
    },
    "https://example.test/a.psd"
  );

  const [burned, screened] = document.layers;
  assert.equal(screened.blendMode, "screen", "screen is implemented in both renderers");
  assert.equal(burned.blendMode, "normal", "an unrepresentable mode still renders");
  assert.equal(burned.status, "Native", "the layer type is native; only its blend mode is not");

  const warning = document.warnings.find((entry) => entry.code === "photoshop.blendMode");
  assert.ok(warning, "the substitution must appear in the compatibility report");
  assert.match(warning.message, /colorBurn/);
  assert.equal(warning.status, "Converted");
});

test("cloud-only refusals name the missing capability rather than saying unsupported", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();

    await assert.rejects(
      () => client.call("photoshop.getActiveDocument"),
      (error) => error.code === "cloud_error" && /no active document/.test(error.message)
    );
    await assert.rejects(
      () => client.call("photoshop.getSelectedLayers"),
      (error) => /no selection state/.test(error.message)
    );
    await assert.rejects(
      () => client.call("photoshop.exportLayers", { href: "https://example.test/a.psd" }),
      (error) => /renders whole documents/.test(error.message)
    );
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("the local plugin wins over the cloud unless the caller asks for cloud", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "photoshop", {
      "photoshop.getDocumentStructure": () => ({ servedBy: "local" })
    });

    const preferred = await client.call("photoshop.getDocumentStructure", {
      href: "https://example.test/a.psd"
    });
    assert.equal(preferred.servedBy, "local", "the open document beats a URL");

    const forced = await client.call(
      "photoshop.getDocumentStructure",
      { href: "https://example.test/a.psd" },
      { transport: "cloud" }
    );
    assert.equal(forced.source, "photoshop");
    assert.equal(forced.name, "Election.psd");

    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("After Effects refuses the cloud transport instead of quietly using the local bridge", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "after-effects", {
      "aftereffects.getProject": () => ({ servedBy: "local" })
    });

    await assert.rejects(
      () => client.call("aftereffects.getProject", {}, { transport: "cloud" }),
      (error) => error.code === "transport_unavailable" && /no cloud API/.test(error.message)
    );

    const local = await client.call("aftereffects.getProject");
    assert.equal(local.servedBy, "local");

    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a cloud mutation still needs operator approval, and reaches Adobe only after it", async () => {
  const { gateway, api, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();

    await assert.rejects(
      () =>
        client.call("photoshop.updateTextLayer", {
          href: "https://example.test/a.psd",
          layerName: "Headline",
          text: "LIVE"
        }),
      (error) => error.code === "approval_required"
    );
    assert.equal(
      api.calls.some(([name]) => name === "modifyDocument"),
      false,
      "an unapproved edit must never reach Adobe"
    );

    assert.ok(client.peerId);
    assert.equal(gateway.approveSession(client.peerId), true);
    const job = await client.call("photoshop.updateTextLayer", {
      href: "https://example.test/a.psd",
      layerName: "Headline",
      text: "LIVE"
    });
    assert.equal(job.jobId, "job-3");

    const [, , , options] = api.calls.find(([name]) => name === "modifyDocument");
    assert.deepEqual(options, { layers: [{ name: "Headline", text: { content: "LIVE" } }] });
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a missing argument is refused before any Adobe call is made", async () => {
  const { gateway, api, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    assert.ok(client.peerId);
    assert.equal(gateway.approveSession(client.peerId), true);

    await assert.rejects(
      () => client.call("photoshop.replaceSmartObject", { href: "https://example.test/a.psd" }),
      (error) => /needs a layerName/.test(error.message)
    );
    assert.equal(api.calls.length, 0);
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a failed Adobe job surfaces its status instead of returning an empty result", async () => {
  const api = fakePhotoshopApi({
    getDocumentManifest: async () => ({ jobId: "job-x", outputs: [{ status: "failed" }] })
  });
  const { gateway, url } = await startGateway({ api });
  const client = makeClient(url);
  try {
    await client.connect();
    await assert.rejects(
      () => client.call("photoshop.getDocumentStructure", { href: "https://example.test/a.psd" }),
      (error) => error.code === "cloud_error" && /finished as "failed"/.test(error.message)
    );
  } finally {
    client.disconnect();
    await gateway.close();
  }
});
