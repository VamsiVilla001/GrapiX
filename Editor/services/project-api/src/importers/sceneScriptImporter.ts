import { createHash } from "node:crypto";
import ts from "typescript";

const MAX_SCRIPT_BYTES = 128 * 1024;

const FORBIDDEN_IDENTIFIERS: Record<string, string> = {
  eval: "dynamic code generation is not allowed",
  Function: "dynamic code generation is not allowed",
  WebAssembly: "dynamic code generation is not allowed",
  require: "require() is not allowed",
  process: "host globals are not allowed",
  globalThis: "host globals are not allowed",
  global: "host globals are not allowed",
  window: "host globals are not allowed",
  document: "host globals are not allowed",
  fetch: "network APIs are not allowed",
  XMLHttpRequest: "network APIs are not allowed",
  WebSocket: "network APIs are not allowed",
  EventSource: "network APIs are not allowed",
  importScripts: "network APIs are not allowed",
  SharedArrayBuffer: "shared-memory APIs are not allowed",
  Atomics: "shared-memory APIs are not allowed",
  child_process: "Node and filesystem APIs are not allowed",
  worker_threads: "Node and filesystem APIs are not allowed"
};

export interface SceneScriptImportReport {
  accepted: boolean;
  checksum: string;
  sizeBytes: number;
  errors: string[];
  warnings: string[];
  apiVersion: 1;
  execution: "control-sandbox";
}

export function inspectSceneScript(bytes: Buffer, fileName: string): SceneScriptImportReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension !== "js" && extension !== "mjs") {
    errors.push("Scene scripts must use a .js or .mjs extension");
  }
  if (bytes.length === 0) errors.push("Scene script is empty");
  if (bytes.length > MAX_SCRIPT_BYTES) errors.push("Scene script exceeds the 128 KiB limit");
  if (bytes.includes(0)) errors.push("Scene script must be UTF-8 text without NUL bytes");

  const source = bytes.toString("utf8");
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const diagnostics = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022 }
  }).diagnostics ?? [];
  if (diagnostics.length > 0) {
    errors.push(`Scene script has invalid JavaScript syntax: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`);
  }
  if (!sourceFile.statements.some(isDefaultExport)) {
    errors.push("Scene script must export one default GrapiX scene module");
  }
  if (!containsDefineSceneScriptCall(sourceFile)) {
    warnings.push("Use defineSceneScript(...) from the GrapiX SDK for validation and typed authoring");
  }
  inspectSyntaxTree(sourceFile, errors);

  return {
    accepted: errors.length === 0,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    errors,
    warnings,
    apiVersion: 1,
    execution: "control-sandbox"
  };
}

function isDefaultExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return !statement.isExportEquals;
  return ts.canHaveModifiers(statement)
    && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true
    && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}
function containsDefineSceneScriptCall(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineSceneScript") {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function inspectSyntaxTree(sourceFile: ts.SourceFile, errors: string[]): void {
  const reported = new Set(errors);
  const report = (value: string): void => {
    if (!reported.has(value)) {
      reported.add(value);
      errors.push(value);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const forbidden = FORBIDDEN_IDENTIFIERS[node.text];
      if (forbidden) report(forbidden);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report("imports are not allowed; use only @grapix/sdk APIs");
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      report("imports are not allowed; use only @grapix/sdk APIs");
    }
    if (ts.isStringLiteral(node) && /^(?:node:|file:)/iu.test(node.text)) {
      report("Node and filesystem APIs are not allowed");
    }
    if (ts.isElementAccessExpression(node)) {
      const property = staticString(node.argumentExpression);
      if (property && FORBIDDEN_IDENTIFIERS[property]) report(FORBIDDEN_IDENTIFIERS[property]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

function staticString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}
