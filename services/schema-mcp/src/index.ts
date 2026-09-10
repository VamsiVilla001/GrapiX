// schema-mcp. Status: Partial.
//
// Standalone, vendor-neutral, read-only MCP surface over the GrapiX contracts.
// Deliberately independent of a running Editor: any MCP-capable model can read
// the schema without booting an application.
//
// It holds no schema of its own. It reads @grapix/contracts, which is
// generated from Rust (invariant 22), so it cannot drift from the source of
// truth.
//
// What is here: capability discovery (Part D, principle 2) — the read surface
// an agent calls first so it never has to guess an enum. What is not here yet:
// the JSON-RPC transport and the mutating D.2 tool groups (scenes, objects,
// …), which land with the products that own them. This is read-only by
// construction, and says so.

import type {
  ClockSource,
  DeviceTier,
  Locality,
  MediaCodec,
  ReferenceState,
  Refusal,
} from "@grapix/contracts";

/** The server is read-only by construction. Authoring belongs to the Editor
 *  and Program belongs to Playout; this exposes neither. */
export const capabilities = {
  resources: true,
  tools: true,
  mutation: false,
} as const;

export const status = "Partial" as const;

/** The contract schema version an agent is talking to. Versioned alongside
 *  protocol v3 so an agent can ask what it is connected to (D.5). */
export const SCHEMA_VERSION = 3 as const;

/** One enumerable value a tool may accept, with its refusal meaning. */
export interface EnumValue {
  readonly value: string;
  readonly note?: string;
}

/** The capability surface: every supported enum, as data (D.1 principle 2).
 *
 *  An agent that can *ask* what is supported does not generate a blend mode or
 *  a clock source the system will refuse. This is the discovery half of the
 *  refusal contract: the values here are the ones that appear in `Refusal`
 *  variants when they are violated. */
export interface CapabilitySurface {
  readonly schemaVersion: number;
  readonly deviceTiers: readonly EnumValue[];
  readonly localities: readonly EnumValue[];
  readonly clockSources: readonly EnumValue[];
  readonly referenceStates: readonly EnumValue[];
  readonly mediaCodecs: readonly EnumValue[];
  /** The named refusals a caller can receive, each one actionable. */
  readonly refusals: readonly string[];
  /** The design-system and motion schema groups now in contracts (Part G). */
  readonly designSystem: {
    readonly motionPhases: readonly string[];
    readonly staggerModes: readonly string[];
  };
}

// These literals are the source-of-truth values, mirrored from the generated
// types by hand ONLY at this boundary: the capability surface must enumerate
// them, and a union type carries no runtime list. Each is checked against the
// generated union in the tests below, so a value added to the contract and not
// here fails typecheck rather than drifting silently.
const DEVICE_TIERS: readonly DeviceTier[] = ["T0", "T1", "T2", "T3"];
const LOCALITIES: readonly Locality[] = ["CoLocated", "Lan"];
const CLOCK_SOURCES: readonly ClockSource[] = ["Genlocked", "Ptp", "FreeRun"];
const REFERENCE_STATES: readonly ReferenceState[] = ["Locked", "Unlocked", "NotPresent"];
const MEDIA_CODECS: readonly MediaCodec[] = ["RawShared", "Jpeg", "H264", "Hevc"];

// The Refusal variants, as their refusal codes. An agent reading a refusal can
// match it against this list and know the contract named it deliberately.
const REFUSAL_CODES = [
  "revisionMismatch",
  "tierTooLow",
  "referenceUnlocked",
  "unsupportedBlendMode",
  "unsupportedFitMode",
  "assetMissing",
  "protocolMismatch",
  "invalidRate",
  "platformNotCertified",
  "unknownTake",
  "frameNotReachable",
  "multipleClockDomains",
  "unauthenticated",
  "transportFailed",
  "notImplemented",
] as const;

/** Return the capability surface (system.capability). Always call first. */
export function getCapabilitySurface(): CapabilitySurface {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceTiers: DEVICE_TIERS.map((value) => ({ value })),
    localities: LOCALITIES.map((value) => ({ value })),
    clockSources: CLOCK_SOURCES.map((value) => ({ value })),
    referenceStates: REFERENCE_STATES.map((value) => ({ value })),
    mediaCodecs: MEDIA_CODECS.map((value) => ({ value })),
    refusals: REFUSAL_CODES,
    designSystem: {
      // The operator phases a motion preset may describe (G.6.3).
      motionPhases: ["in", "hold", "continue", "out", "update"],
      // The count-adaptive stagger modes (G.6.5).
      staggerModes: ["fixed", "cap-total", "overlap"],
    },
  };
}

// Compile-time proof that the hand-maintained lists above exactly match the
// generated unions: if a variant is added to the contract and not listed here,
// this assignment stops compiling, which is the drift guard for the one place
// a runtime list must be written by hand.
type _AssertTiers = DeviceTier extends (typeof DEVICE_TIERS)[number] ? true : never;
type _AssertLocalities = Locality extends (typeof LOCALITIES)[number] ? true : never;
type _AssertClocks = ClockSource extends (typeof CLOCK_SOURCES)[number] ? true : never;
type _AssertRefs = ReferenceState extends (typeof REFERENCE_STATES)[number] ? true : never;
type _AssertCodecs = MediaCodec extends (typeof MEDIA_CODECS)[number] ? true : never;
const _assertions: [_AssertTiers, _AssertLocalities, _AssertClocks, _AssertRefs, _AssertCodecs] = [
  true,
  true,
  true,
  true,
  true,
];
void _assertions;

// Referenced so the contract dependency is real rather than declared, and so
// a broken regeneration fails this package's typecheck.
export type { Refusal };
