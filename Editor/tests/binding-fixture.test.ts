// The preview's binding resolver (src/bindings.ts) and gx_contracts::bindings
// are held to the same answers by one fixture (build plan 0.9):
// Shared/contracts/fixtures/binding-resolution.json, which
// Shared/contracts/tests/binding_fixture.rs reads on the Rust side. Same
// issues, in the same order and wording; same resolved values; a case with
// issues refuses on both sides.

import { describe, expect, it } from "vitest";

import type { BindingIssue, SceneDocument } from "@grapix/contracts";
import fixture from "../../Shared/contracts/fixtures/binding-resolution.json";
import { resolveSceneBindings, sceneBindingIssues } from "../src/bindings";

interface FixtureCase {
  readonly name: string;
  readonly scene: SceneDocument;
  readonly issues: readonly BindingIssue[];
  readonly resolved?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const cases = (fixture as unknown as { readonly cases: readonly FixtureCase[] }).cases;

describe("binding resolution fixture shared with gx_contracts::bindings", () => {
  it("still holds its cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const fixtureCase of cases) {
    it(fixtureCase.name, () => {
      // The generated contract type is the one the preview reports (0.9).
      const issues: readonly BindingIssue[] = sceneBindingIssues(fixtureCase.scene);
      expect(issues).toEqual(fixtureCase.issues);

      const resolution = resolveSceneBindings(fixtureCase.scene);
      if (fixtureCase.issues.length === 0) {
        expect(resolution.ok).toBe(true);
        if (!resolution.ok) return;
        const resolved = fixtureCase.resolved ?? {};
        expect(Object.keys(resolved).length).toBeGreaterThan(0);
        for (const [objectId, properties] of Object.entries(resolved)) {
          const object = resolution.document.objects.find((candidate) => candidate.id === objectId);
          expect(object, objectId).toBeDefined();
          for (const [property, expected] of Object.entries(properties)) {
            expect((object as unknown as Record<string, unknown>)[property], `${objectId}.${property}`).toEqual(
              expected,
            );
          }
        }
      } else {
        expect(resolution).toEqual({ ok: false, issues: fixtureCase.issues });
      }
    });
  }
});
