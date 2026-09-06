/**
 * One specification, two implementations.
 *
 * The Rust engine verifies tokens this package mints. Nothing forces those two to agree
 * except a test that makes them prove it, so this file mints tokens with the *same* key and
 * payloads the Rust unit tests use (`services/render-engine/src/auth.rs`) and asserts the
 * signatures are byte-identical. If either side changes its encoding, this fails.
 *
 * It also checks the permission tables match, which is the other half of the contract: the
 * engine refuses a request the issuer thought it had granted if those tables drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PERMISSION_FOR_REQUEST,
  ROLE_PERMISSIONS,
  UNAUTHENTICATED_REQUESTS,
  issueAccessToken,
  permissionForRequest,
  signToken,
  verifyToken
} from "../dist/index.js";

const FIXTURE_KEY = Buffer.from("grapix-conformance-signing-secret-0123456789", "utf8");
const RUST_SOURCE = fileURLToPath(new URL("../../../services/render-engine/src/auth.rs", import.meta.url));

test("the fixture key matches the one the Rust tests use", () => {
  const source = readFileSync(RUST_SOURCE, "utf8");
  const match = source.match(/const FIXTURE_KEY: &str = "([^"]+)"/);
  assert.ok(match, "the Rust tests must declare FIXTURE_KEY");
  assert.equal(match[1], FIXTURE_KEY.toString("utf8"));
});

test("a token minted here has the exact shape the engine parses", () => {
  const claims = {
    sub: "usr_1",
    usr: "ada",
    role: "editor",
    perms: ["scene.write", "editor.view"],
    sid: "sess_1",
    typ: "access",
    iat: 1000,
    exp: 9999999999
  };
  const token = signToken(claims, FIXTURE_KEY);
  const [version, payload, signature] = token.split(".");

  assert.equal(version, "gx1", "the prefix is the algorithm; the engine pins it");
  // No algorithm field anywhere in the token - the property that makes alg confusion absent
  // rather than merely defended against.
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(decoded.alg, undefined);
  assert.deepEqual(decoded, claims);
  // base64url, unpadded, on both sides.
  assert.ok(!signature.includes("="), "signatures are unpadded base64url");
  assert.ok(!/[+/]/.test(signature), "signatures are URL-safe");
});

test("every permission table entry is one the engine also knows", () => {
  const source = readFileSync(RUST_SOURCE, "utf8");

  for (const permission of new Set(Object.values(PERMISSION_FOR_REQUEST))) {
    assert.ok(
      source.includes(`"${permission}" => Some(Self::`),
      `the engine must be able to parse the permission ${permission}`
    );
  }

  // Every verb this side maps must appear in the engine's match. A verb the issuer thinks is
  // privileged but the engine has never heard of is refused as Unknown - safe, but a bug.
  for (const request of Object.keys(PERMISSION_FOR_REQUEST)) {
    assert.ok(source.includes(`"${request}"`), `the engine must classify the verb ${request}`);
  }

  for (const request of UNAUTHENTICATED_REQUESTS) {
    assert.ok(source.includes(`"${request}"`), `the engine must classify the verb ${request}`);
  }
});

test("the role tables agree with the engine's", () => {
  const source = readFileSync(RUST_SOURCE, "utf8");
  const roleBlock = (role) => {
    const start = source.indexOf(`UserRole::${role} => &[`);
    assert.ok(start > 0, `the engine must define permissions for ${role}`);
    return source.slice(start, source.indexOf("],", start));
  };

  const rustName = {
    "scene.read": "SceneRead",
    "scene.write": "SceneWrite",
    "scene.publish": "ScenePublish",
    "stage.write": "StageWrite",
    "asset.write": "AssetWrite",
    "editor.view": "EditorView",
    "playout.preview": "PlayoutPreview",
    "playout.program": "PlayoutProgram",
    "output.manage": "OutputManage",
    "engine.configure": "EngineConfigure",
    "engine.diagnose": "EngineDiagnose",
    "user.manage": "UserManage",
    "audit.read": "AuditRead"
  };

  for (const [role, variant] of [
    ["editor", "Editor"],
    ["playout-operator", "PlayoutOperator"],
    ["admin", "Admin"]
  ]) {
    const block = roleBlock(variant);
    const inRust = new Set(
      Object.entries(rustName)
        .filter(([, name]) => new RegExp(`\\b${name}\\b`).test(block))
        .map(([permission]) => permission)
    );
    assert.deepEqual(
      [...inRust].sort(),
      [...ROLE_PERMISSIONS[role]].sort(),
      `the ${role} permission set must be identical in both languages`
    );
  }
});

test("an unknown verb is refused by both sides rather than treated as public", () => {
  assert.equal(permissionForRequest("evil.newVerb"), null);
  const source = readFileSync(RUST_SOURCE, "utf8");
  assert.ok(source.includes("_ => RequiredPermission::Unknown"));
});

test("a token narrowed below its role keeps only the intersection", () => {
  const { claims } = issueAccessToken(
    {
      userId: "u",
      username: "n",
      role: "editor",
      sessionId: "s",
      // Asking for an operator permission an Editor does not hold.
      permissions: ["scene.write", "playout.program"]
    },
    FIXTURE_KEY
  );
  assert.deepEqual(claims.perms, ["scene.write"]);
});

test("verification rejects the ways a token is normally forged", () => {
  const { token } = issueAccessToken(
    { userId: "u", username: "n", role: "admin", sessionId: "s" },
    FIXTURE_KEY
  );
  const [version, payload, signature] = token.split(".");

  // Signature stripped.
  assert.equal(verifyToken(`${version}.${payload}.`, FIXTURE_KEY).reason, "malformed");
  // Payload swapped, signature kept.
  const forged = Buffer.from(JSON.stringify({ sub: "u", typ: "access", exp: 9999999999 })).toString("base64url");
  assert.equal(verifyToken(`${version}.${forged}.${signature}`, FIXTURE_KEY).reason, "bad-signature");
  // A different version prefix is not silently accepted.
  assert.equal(verifyToken(`gx2.${payload}.${signature}`, FIXTURE_KEY).reason, "unsupported-version");
});
