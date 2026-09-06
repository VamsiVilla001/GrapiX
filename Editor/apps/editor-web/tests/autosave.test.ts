import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOSAVE_INTERVAL_MAX,
  AUTOSAVE_INTERVAL_MIN,
  AUTOSAVE_VERSIONS_MAX,
  AUTOSAVE_VERSIONS_MIN,
  DEFAULT_PREFERENCES,
  usePreferencesStore
} from "../src/store/preferencesStore";

// The controller listens for visibility changes and lives outside React, so it needs a
// document. Stubbed before importing it, never after: the import is what the tests exercise.
const documentListeners = new Map<string, EventListener>();
(globalThis as unknown as { document: unknown }).document = {
  visibilityState: "visible",
  addEventListener: (type: string, handler: EventListener) => documentListeners.set(type, handler),
  removeEventListener: (type: string) => documentListeners.delete(type)
};

/**
 * Every request is answered here. A live project service on 4100 is the normal state of a
 * development machine, and a test that reached it would write snapshots into a real project.
 */
let serviceReachable = false;
const requestedUrls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  requestedUrls.push(url);
  if (!serviceReachable) throw new TypeError("Failed to fetch");
  if (url.endsWith("/autosave")) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        autosave: {
          version: 1,
          fileName: "Scene autosave 1.json",
          sceneName: "Scene",
          revision: 3,
          savedAt: "2026-08-04T05:00:00.000Z",
          sizeBytes: 12
        }
      })
    } as unknown as Response;
  }
  return {
    ok: true,
    json: async () => ({
      ok: true,
      scene: {
        id: "001",
        name: "Scene",
        updatedAt: "2026-08-04T05:00:00.000Z",
        objectCount: 0,
        assetCount: 0,
        materialCount: 0,
        revision: 3
      }
    })
  } as unknown as Response;
}) as typeof fetch;

const { nextRetryDelayMs, startAutosave } = await import("../src/lib/autosave");
const { useEditorStore } = await import("../src/store/editorStore");

const saveRequests = () => requestedUrls.filter((url) => url.endsWith("/api/scenes")).length;
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("preferences store initializes with defaults and clamps invalid inputs", () => {
  usePreferencesStore.getState().resetPreferences();
  const initial = usePreferencesStore.getState().preferences;

  assert.deepEqual(initial, DEFAULT_PREFERENCES);

  usePreferencesStore.getState().updateAutosave({
    intervalMinutes: -10,
    maxVersions: 999
  });

  const clamped = usePreferencesStore.getState().preferences.autosave;
  assert.equal(clamped.intervalMinutes, AUTOSAVE_INTERVAL_MIN);
  assert.equal(clamped.maxVersions, AUTOSAVE_VERSIONS_MAX);

  usePreferencesStore.getState().resetPreferences();
});

test("the retry backoff starts at 2s, doubles, and stops at 30s", () => {
  assert.equal(nextRetryDelayMs(0), 2_000);
  assert.equal(nextRetryDelayMs(2_000), 4_000);
  assert.equal(nextRetryDelayMs(16_000), 30_000);
  assert.equal(nextRetryDelayMs(30_000), 30_000, "the ceiling must hold");
  assert.equal(nextRetryDelayMs(Number.NaN), 2_000, "a lost delay must not disable the retry");
});

/**
 * The failure this exists for: the project service went away for a moment on 2026-08-04, one
 * write failed, and the Editor sat on "Not saved" for minutes afterwards with the document
 * only in the window. Every other trigger in the controller is an edit, so with no retry the
 * operator has to make one before their work reaches disk.
 */
test("a failed write re-arms itself and recovers without an edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  usePreferencesStore.getState().resetPreferences();
  // Autosave ships disabled — saving is a manual act — so a test about autosave's retry has to
  // turn it on rather than inherit it from the defaults.
  usePreferencesStore.getState().updateAutosave({ enabled: true });
  serviceReachable = false;
  requestedUrls.length = 0;
  useEditorStore.setState({
    hasActiveScene: true,
    historyTransaction: null,
    saveStatus: "local",
    saveError: null
  });

  const controller = startAutosave();
  try {
    await controller.flush("test");
    assert.equal(saveRequests(), 1);
    assert.equal(useEditorStore.getState().saveStatus, "error");
    assert.equal(
      useEditorStore.getState().saveError,
      "Project service unreachable on 127.0.0.1:4100",
      "the operator must be told what is unreachable, not 'Failed to fetch'"
    );

    // No edit, no gesture boundary, no visibility change: only a retry can move this.
    t.mock.timers.tick(2_000);
    await settled();
    assert.equal(saveRequests(), 2);
    assert.equal(useEditorStore.getState().saveStatus, "error");

    // Backoff, so the second retry is not due yet at the first interval.
    t.mock.timers.tick(2_000);
    await settled();
    assert.equal(saveRequests(), 2, "the backoff must double rather than poll at a fixed rate");

    serviceReachable = true;
    t.mock.timers.tick(2_000);
    await settled();
    assert.equal(saveRequests(), 3);
    assert.equal(useEditorStore.getState().saveStatus, "saved");
    assert.equal(useEditorStore.getState().saveError, null);

    // Recovered: the timer is disarmed, so a healthy editor is not writing on a timer.
    t.mock.timers.tick(60_000);
    await settled();
    assert.equal(saveRequests(), 3);
  } finally {
    controller.stop();
    useEditorStore.setState({ hasActiveScene: false, saveStatus: "local", saveError: null });
  }
});

/** An operator who turned autosave off is driving saves themselves; a retry would take that back. */
test("no retry is armed while autosave is disabled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  usePreferencesStore.getState().updateAutosave({ enabled: false });
  serviceReachable = false;
  requestedUrls.length = 0;
  useEditorStore.setState({
    hasActiveScene: true,
    historyTransaction: null,
    saveStatus: "local",
    saveError: null
  });

  const controller = startAutosave();
  try {
    await controller.flush("test");
    assert.equal(saveRequests(), 1);

    t.mock.timers.tick(120_000);
    await settled();
    assert.equal(saveRequests(), 1, "a disabled autosave must not write in the background");
    assert.equal(useEditorStore.getState().saveStatus, "error", "the failure is still reported");
  } finally {
    controller.stop();
    useEditorStore.setState({ hasActiveScene: false, saveStatus: "local", saveError: null });
    usePreferencesStore.getState().resetPreferences();
  }
});
