import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../index.js";

/**
 * Profile API behaviour that is easy to regress:
 * - credentials must never appear in a response body
 * - concurrent layout saves must not tear the stored file or drop each other
 */

async function withServer<T>(run: (app: Awaited<ReturnType<typeof createApiServer>>) => Promise<T>) {
  const app = await createApiServer({ logger: false });

  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

const json = (response: { body: string }): Record<string, never> => JSON.parse(response.body);

test("a stored figma token never reaches a response body", async () => {
  await withServer(async (app) => {
    const secret = "figd_super_secret_value_9876";
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Token Test", figmaToken: secret }
    });

    assert.equal(created.statusCode, 200);
    assert.ok(!created.body.includes(secret), "create response must not echo the token");

    const profile = (json(created) as unknown as { profile: { profileId: string } }).profile;

    const listed = await app.inject({ method: "GET", url: "/api/profiles" });
    assert.ok(!listed.body.includes(secret), "list response must not include the token");
    assert.ok(listed.body.includes("9876"), "but it should carry the last-four hint");

    const launched = await app.inject({
      method: "POST",
      url: `/api/profiles/${profile.profileId}/launch`
    });
    assert.equal(launched.statusCode, 200);
    assert.ok(!launched.body.includes(secret));

    await app.inject({ method: "DELETE", url: `/api/profiles/${profile.profileId}` });
  });
});

test("a bodyless launch POST is accepted", async () => {
  await withServer(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Launch Test" }
    });
    const profile = (json(created) as unknown as { profile: { profileId: string } }).profile;

    const launched = await app.inject({
      method: "POST",
      url: `/api/profiles/${profile.profileId}/launch`
    });

    assert.equal(launched.statusCode, 200);
    assert.ok(
      (json(launched) as unknown as { profile: { lastOpenedAt?: string } }).profile.lastOpenedAt
    );

    await app.inject({ method: "DELETE", url: `/api/profiles/${profile.profileId}` });
  });
});

test("concurrent layout saves keep both halves and never tear the file", async () => {
  await withServer(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Race Test" }
    });
    const profile = (json(created) as unknown as { profile: { profileId: string } }).profile;

    // The editor fires a dock save and a panel-size save together; before the per-profile
    // lock and the merging update these interleaved and one read a half-written file.
    const saves = Array.from({ length: 12 }, (_, index) =>
      app.inject({
        method: "PATCH",
        url: `/api/profiles/${profile.profileId}`,
        payload:
          index % 2 === 0
            ? { workspaceLayout: { dock: { left: ["templates", "design-import"] }, panelSizes: {} } }
            : {
                workspaceLayout: {
                  dock: {},
                  panelSizes: { [`group-${index}`]: { left: 20, center: 60, right: 20 } }
                }
              }
      })
    );

    const results = await Promise.all(saves);

    for (const result of results) {
      assert.equal(result.statusCode, 200, `save failed: ${result.body}`);
    }

    const final = await app.inject({ method: "GET", url: `/api/profiles` });
    const profiles = (json(final) as unknown as {
      profiles: Array<{
        profileId: string;
        workspaceLayout: { dock: Record<string, string[]>; panelSizes: Record<string, unknown> };
      }>;
    }).profiles;
    const stored = profiles.find((entry) => entry.profileId === profile.profileId);

    assert.ok(stored, "profile survived the concurrent writes");
    assert.deepEqual(stored.workspaceLayout.dock.left, ["templates", "design-import"]);
    // Every panel-size save merged rather than clobbering the previous one.
    assert.equal(Object.keys(stored.workspaceLayout.panelSizes).length, 6);

    await app.inject({ method: "DELETE", url: `/api/profiles/${profile.profileId}` });
  });
});

test("clearing a token removes it and reports no credential", async () => {
  await withServer(async (app) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Clear Test", figmaToken: "figd_abcdef123456" }
    });
    const profile = (json(created) as unknown as { profile: { profileId: string } }).profile;

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/profiles/${profile.profileId}`,
      payload: { figmaToken: "" }
    });

    assert.equal(cleared.statusCode, 200);
    assert.equal(
      (json(cleared) as unknown as {
        profile: { credentialHints: { figmaToken: { present: boolean } } };
      }).profile.credentialHints.figmaToken.present,
      false
    );

    // Figma import must now refuse rather than call the API with no token.
    const imported = await app.inject({
      method: "POST",
      url: "/api/imports/figma",
      payload: { profileId: profile.profileId, target: "https://www.figma.com/design/abc123XYZ89/Show" }
    });

    assert.equal(imported.statusCode, 400);
    assert.match((json(imported) as unknown as { error: string }).error, /no Figma personal access token/);

    await app.inject({ method: "DELETE", url: `/api/profiles/${profile.profileId}` });
  });
});
