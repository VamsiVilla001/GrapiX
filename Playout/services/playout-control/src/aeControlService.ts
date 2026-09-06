import type { AeDynamicControl, AeRuntimeContainer } from "@grapix/ae-runtime-contract";
import type { AeRuntimePropertyMetadata, AeRuntimePropertyTarget, AeRuntimeResult } from "@grapix/adobe-common-schema";
import { randomUUID } from "node:crypto";
import type { AeRuntimeSupervisor } from "./aeRuntimeSupervisor.js";

export type AeControlRefusalCode =
  | "CONTROL_UNDECLARED"
  | "CONTROL_READ_ONLY"
  | "CONTROL_VALIDATION_FAILED"
  | "CONTROL_TARGET_STALE";

export class AeControlRefusal extends Error {
  constructor(readonly code: AeControlRefusalCode, message: string) {
    super(message);
    this.name = "AeControlRefusal";
  }
}

export interface AeControlWriteRequest {
  controlId: string;
  value: unknown;
  policy: AeDynamicControl["updatePolicy"];
  revision?: number;
}

export class AeControlService {
  constructor(private readonly runtime: Pick<AeRuntimeSupervisor, "call">) {}

  async validate(container: AeRuntimeContainer, controlId: string): Promise<AeDynamicControl> {
    const control = declaredControl(container, controlId);
    if (!control.writable) throw new AeControlRefusal("CONTROL_READ_ONLY", `control ${controlId} is read-only`);
    const target = runtimeTarget(control);
    const response = await this.runtime.call<unknown>("READ_PROPERTY_METADATA", target, {
      expectedProjectDigest: container.projectDigest
    });
    if (!response.ok) {
      control.validation.status = response.error?.code === "TARGET_NOT_FOUND" ? "stale" : "rebind-required";
      control.validation.reason = response.error?.message ?? "runtime metadata validation failed";
      throw new AeControlRefusal(
        response.error?.code === "TARGET_NOT_FOUND" ? "CONTROL_TARGET_STALE" : "CONTROL_VALIDATION_FAILED",
        control.validation.reason
      );
    }
    const metadata = selectMetadata(response.result, target);
    if (!metadata || !metadata.writable) {
      control.validation.status = metadata ? "disabled" : "stale";
      control.validation.reason = metadata?.readOnlyReason ?? "canonical property target was not found";
      throw new AeControlRefusal(metadata ? "CONTROL_READ_ONLY" : "CONTROL_TARGET_STALE", control.validation.reason);
    }
    if (metadata.valueType !== control.kind) {
      control.validation.status = "rebind-required";
      control.validation.reason = `declared ${control.kind} does not match runtime ${metadata.valueType}`;
      throw new AeControlRefusal("CONTROL_VALIDATION_FAILED", control.validation.reason);
    }
    control.validation = {
      status: "valid",
      reason: null,
      validatedProjectDigest: container.projectDigest,
      structuralFingerprint: metadata.structuralFingerprint,
      validatedAt: new Date().toISOString()
    };
    return control;
  }

  /**
   * Check one value against a declared control's kind and constraints.
   *
   * Exposed because the revision path validates every member before any of them is written, and it
   * must use the same rules as a single write rather than a second copy of them.
   */
  assertValue(control: AeDynamicControl, value: unknown): void {
    assertControlValue(control, value);
  }

  async write(container: AeRuntimeContainer, request: AeControlWriteRequest): Promise<AeRuntimeResult> {
    const control = await this.validate(container, request.controlId);
    if (control.updatePolicy !== request.policy) {
      throw new AeControlRefusal("CONTROL_VALIDATION_FAILED", `control policy is ${control.updatePolicy}, not ${request.policy}`);
    }
    assertControlValue(control, request.value);
    return this.runtime.call("SET_PROPERTY", { ...runtimeTarget(control), value: request.value }, {
      expectedProjectDigest: container.projectDigest,
      idempotencyKey: randomUUID(),
      ...(request.revision !== undefined ? { revision: request.revision } : {})
    });
  }
}

function declaredControl(container: AeRuntimeContainer, controlId: string): AeDynamicControl {
  const control = container.controls.find((candidate) => candidate.controlId === controlId);
  if (!control) throw new AeControlRefusal("CONTROL_UNDECLARED", `control ${controlId} is not declared by container ${container.id}`);
  if (control.validation.status === "disabled") throw new AeControlRefusal("CONTROL_READ_ONLY", control.validation.reason ?? "control is disabled");
  return control;
}

function runtimeTarget(control: AeDynamicControl): AeRuntimePropertyTarget {
  return {
    compositionItemId: control.target.compositionItemId,
    layerId: control.target.layerId,
    sourceItemId: control.target.sourceItemId,
    path: control.target.propertyPath.map((segment) => ({ ...segment }))
  };
}

function selectMetadata(result: unknown, target: AeRuntimePropertyTarget): AeRuntimePropertyMetadata | null {
  const candidates = Array.isArray(result) ? result : [result];
  return (candidates as AeRuntimePropertyMetadata[]).find((candidate) =>
    candidate?.target?.compositionItemId === target.compositionItemId &&
    candidate.target.layerId === target.layerId &&
    candidate.target.path.length === target.path.length &&
    candidate.target.path.every((segment, index) => segment.matchName === target.path[index]?.matchName && segment.ordinal === target.path[index]?.ordinal)
  ) ?? null;
}

function assertControlValue(control: AeDynamicControl, value: unknown): void {
  const fail = (reason: string): never => { throw new AeControlRefusal("CONTROL_VALIDATION_FAILED", reason); };
  switch (control.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new AeControlRefusal("CONTROL_VALIDATION_FAILED", "number control requires a finite number");
      if (control.constraints?.minimum !== undefined && value < control.constraints.minimum) fail("number is below the declared minimum");
      if (control.constraints?.maximum !== undefined && value > control.constraints.maximum) fail("number is above the declared maximum");
      return;
    }
    case "text": if (typeof value !== "string") fail("text control requires a string"); return;
    case "boolean": if (typeof value !== "boolean") fail("boolean control requires a boolean"); return;
    case "color": if (!isNumberTuple(value, 4)) fail("color control requires four finite channels"); return;
    case "point2d": if (!isNumberTuple(value, 2)) fail("point2d control requires two finite coordinates"); return;
    case "point3d": if (!isNumberTuple(value, 3)) fail("point3d control requires three finite coordinates"); return;
    case "enum": if (typeof value !== "string" || !control.constraints?.enumValues?.includes(value)) fail("enum value is not declared"); return;
    case "image":
    case "video": if (typeof value !== "string" || !control.constraints?.acceptedAssetHandles?.includes(value)) fail("asset handle is not prevalidated"); return;
  }
}

function isNumberTuple(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}
