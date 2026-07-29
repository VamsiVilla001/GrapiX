import {
  resolveDataPath,
  type GrapixAutomationAction,
  type GrapixTriggerEvent,
  type GrapixTriggerRule,
  type RundownDocument,
  type SceneConditionExpression,
  type SceneScriptPermission
} from "@grapix/shared-types";

export const GRAPIX_SDK_VERSION = "0.1.0";
export const GRAPIX_SCENE_SCRIPT_API_VERSION = 1 as const;

export interface ConditionContext {
  event: GrapixTriggerEvent;
  sceneData: Record<string, unknown>;
  rundownVariables: Record<string, unknown>;
}

export interface MatchedTrigger {
  triggerId: string;
  name: string;
  priority: number;
  actions: GrapixAutomationAction[];
}

export interface TriggerEvaluation {
  event: GrapixTriggerEvent;
  matched: MatchedTrigger[];
  actions: GrapixAutomationAction[];
}

export function evaluateCondition(
  condition: SceneConditionExpression,
  context: ConditionContext
): boolean {
  switch (condition.kind) {
    case "all":
      return condition.conditions.every((item) => evaluateCondition(item, context));
    case "any":
      return condition.conditions.some((item) => evaluateCondition(item, context));
    case "not":
      return !evaluateCondition(condition.condition, context);
    case "exists":
      return resolveOperand(condition.operand, context) !== undefined;
    case "compare": {
      const left = resolveOperand(condition.left, context);
      const right = resolveOperand(condition.right, context);
      return compareValues(left, condition.operator, right, condition.caseSensitive ?? false);
    }
  }
}

export class GrapixSequenceEngine {
  private readonly firedOnce = new Set<string>();
  private readonly lastFiredAt = new Map<string, number>();

  constructor(private readonly rundown: RundownDocument) {}

  process(
    event: GrapixTriggerEvent,
    sceneData: Record<string, unknown> = {}
  ): TriggerEvaluation {
    const activeSequence = this.rundown.sequences.find(
      (sequence) => sequence.sequenceId === this.rundown.activeSequenceId
    ) ?? this.rundown.sequences[0];
    const rules = activeSequence?.triggers ?? [];
    const context: ConditionContext = {
      event,
      sceneData,
      rundownVariables: this.rundown.variables
    };
    const matched = rules
      .filter((rule) => this.matchesRule(rule, context))
      .sort((left, right) => right.priority - left.priority || left.triggerId.localeCompare(right.triggerId))
      .map((rule) => {
        this.lastFiredAt.set(rule.triggerId, event.timestampMs);
        if (rule.once) this.firedOnce.add(rule.triggerId);
        return {
          triggerId: rule.triggerId,
          name: rule.name,
          priority: rule.priority,
          actions: structuredClone(rule.actions)
        };
      });
    return {
      event,
      matched,
      actions: matched.flatMap((item) => item.actions)
    };
  }

  reset(): void {
    this.firedOnce.clear();
    this.lastFiredAt.clear();
  }

  private matchesRule(rule: GrapixTriggerRule, context: ConditionContext): boolean {
    if (!rule.enabled || rule.event.type !== context.event.type) return false;
    if (rule.event.name && rule.event.name !== context.event.name) return false;
    if (rule.once && this.firedOnce.has(rule.triggerId)) return false;
    const lastFiredAt = this.lastFiredAt.get(rule.triggerId);
    if (lastFiredAt !== undefined && context.event.timestampMs - lastFiredAt < (rule.cooldownMs ?? 0)) {
      return false;
    }
    return !rule.condition || evaluateCondition(rule.condition, context);
  }
}

export interface GrapixSceneScriptApi {
  readonly sceneId: string;
  readonly event: GrapixTriggerEvent;
  getData(path?: string): unknown;
  patchData(path: string, value: unknown): void;
  preview(sceneId?: string): void;
  take(sceneId?: string, transitionId?: string): void;
  release(sceneId?: string): void;
  startTimeline(fromFrame?: number): void;
  pauseTimeline(): void;
  emit(name: string, payload?: Record<string, unknown>): void;
}

export interface GrapixSceneScriptModule {
  apiVersion: 1;
  name?: string;
  onLoad?: (api: GrapixSceneScriptApi) => void | Promise<void>;
  onEvent?: (api: GrapixSceneScriptApi) => void | Promise<void>;
  onUnload?: (api: GrapixSceneScriptApi) => void | Promise<void>;
}

export function defineSceneScript(module: GrapixSceneScriptModule): GrapixSceneScriptModule {
  if (module.apiVersion !== GRAPIX_SCENE_SCRIPT_API_VERSION) {
    throw new Error(`Unsupported GrapiX scene-script API version ${String(module.apiVersion)}`);
  }
  return Object.freeze({ ...module });
}

/**
 * Create the capability-scoped API injected by a separate script worker.
 * This collector never evaluates source text; hosts must load approved modules
 * in their isolated worker and then forward only these typed actions.
 */
export function createSceneScriptApi(options: {
  sceneId: string;
  event: GrapixTriggerEvent;
  data: Record<string, unknown>;
  permissions: SceneScriptPermission[];
  maxActions?: number;
}): { api: GrapixSceneScriptApi; actions: GrapixAutomationAction[] } {
  const permissions = new Set(options.permissions);
  const actions: GrapixAutomationAction[] = [];
  const maxActions = Math.max(1, Math.min(options.maxActions ?? 64, 256));
  const enqueue = (permission: SceneScriptPermission, action: GrapixAutomationAction) => {
    if (!permissions.has(permission)) throw new Error(`Scene script lacks ${permission} permission`);
    if (actions.length >= maxActions) throw new Error(`Scene script exceeded ${maxActions} actions`);
    actions.push(structuredClone(action));
  };
  const api: GrapixSceneScriptApi = Object.freeze({
    sceneId: options.sceneId,
    event: structuredClone(options.event),
    getData(path = "") {
      if (!permissions.has("read-data")) throw new Error("Scene script lacks read-data permission");
      return path ? structuredClone(resolveDataPath(options.data, path)) : structuredClone(options.data);
    },
    patchData(path: string, value: unknown) {
      enqueue("patch-data", { type: "patch-data", sceneId: options.sceneId, path, value });
    },
    preview(sceneId = options.sceneId) {
      enqueue("control-preview", { type: "preview-scene", sceneId });
    },
    take(sceneId = options.sceneId, transitionId?: string) {
      enqueue("control-program", { type: "take-scene", sceneId, transitionId });
    },
    release(sceneId = options.sceneId) {
      enqueue("control-program", { type: "release-scene", sceneId });
    },
    startTimeline(fromFrame?: number) {
      enqueue("control-timeline", { type: "start-timeline", sceneId: options.sceneId, fromFrame });
    },
    pauseTimeline() {
      enqueue("control-timeline", { type: "pause-timeline", sceneId: options.sceneId });
    },
    emit(name: string, payload?: Record<string, unknown>) {
      enqueue("emit-event", { type: "emit-event", name, payload });
    }
  });
  return { api, actions };
}

function resolveOperand(
  operand: { source: string; path?: string; value?: unknown },
  context: ConditionContext
): unknown {
  switch (operand.source) {
    case "literal":
      return operand.value;
    case "event":
      return operand.path ? resolveDataPath(context.event.payload, operand.path) : context.event.payload;
    case "scene-data":
      return operand.path ? resolveDataPath(context.sceneData, operand.path) : context.sceneData;
    case "rundown-variable":
      return operand.path ? resolveDataPath(context.rundownVariables, operand.path) : context.rundownVariables;
    default:
      return undefined;
  }
}

function compareValues(
  left: unknown,
  operator: string,
  right: unknown,
  caseSensitive: boolean
): boolean {
  const normalize = (value: unknown) =>
    typeof value === "string" && !caseSensitive ? value.toLocaleLowerCase() : value;
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  switch (operator) {
    case "eq": return deepEqual(normalizedLeft, normalizedRight);
    case "not-eq": return !deepEqual(normalizedLeft, normalizedRight);
    case "gt": return typeof normalizedLeft === "number" && typeof normalizedRight === "number" && normalizedLeft > normalizedRight;
    case "gte": return typeof normalizedLeft === "number" && typeof normalizedRight === "number" && normalizedLeft >= normalizedRight;
    case "lt": return typeof normalizedLeft === "number" && typeof normalizedRight === "number" && normalizedLeft < normalizedRight;
    case "lte": return typeof normalizedLeft === "number" && typeof normalizedRight === "number" && normalizedLeft <= normalizedRight;
    case "contains":
      return typeof normalizedLeft === "string"
        ? normalizedLeft.includes(String(normalizedRight))
        : Array.isArray(normalizedLeft) && normalizedLeft.some((item) => deepEqual(normalize(item), normalizedRight));
    case "starts-with":
      return typeof normalizedLeft === "string" && normalizedLeft.startsWith(String(normalizedRight));
    case "ends-with":
      return typeof normalizedLeft === "string" && normalizedLeft.endsWith(String(normalizedRight));
    case "in":
      return Array.isArray(normalizedRight) && normalizedRight.some((item) => deepEqual(normalizedLeft, normalize(item)));
    case "matches":
      return safeRegexMatch(normalizedLeft, normalizedRight);
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeRegexMatch(value: unknown, pattern: unknown): boolean {
  if (typeof value !== "string" || typeof pattern !== "string") return false;
  if (value.length > 4096 || pattern.length === 0 || pattern.length > 128) return false;
  if (/\\[1-9]|\\k<|\(\?[=!<]|(?:\*|\+|\{\d+(?:,\d*)?\})(?:\s*)(?:\*|\+|\{)/u.test(pattern)) return false;
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return false;
  }
}
