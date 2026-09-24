import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import {
  defaultSysTypeForHost,
  expandMakeValue,
  inferSysTypeFromCompilerArgs,
  parseMakefileVarsText,
  sysTypeToPredefinedMacro,
  CplSysType
} from "./cplTarget";

let client: LanguageClient | undefined;

function findMakefileUpwards(startPath?: string): string | undefined {
  if (!startPath) return undefined;
  let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    const candidate = path.join(dir, "Makefile");
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseMakefileVars(makefilePath: string): Map<string, string> {
  try {
    const text = fs.readFileSync(makefilePath, "utf8");
    return parseMakefileVarsText(text);
  } catch {}

  return new Map<string, string>();
}

function findTestsDirUpwards(startPath?: string): string | undefined {
  if (!startPath) return undefined;
  let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    const candidate = path.join(dir, "tests", "module_testing.py");
    if (fs.existsSync(candidate)) return path.join(dir, "tests");

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const ONLY_THIS_MARKER = ": ONLY_THIS :";
const temporaryOnlyThisMarkers = new Map<string, number>();

function findOutputBlockOffset(text: string): number {
  const match = text.match(/^[ \t]*:\/[ \t]*OUTPUT\b/m);
  return match?.index ?? -1;
}

function hasOnlyThisMarkerBeforeOutput(text: string): boolean {
  const outputOffset = findOutputBlockOffset(text);
  const searchable = outputOffset >= 0 ? text.slice(0, outputOffset) : text;
  return searchable.split(/\r\n|\n|\r/).some((line) => line.trim() === ONLY_THIS_MARKER);
}

function preferredNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function insertOnlyThisMarker(text: string): string {
  const newline = preferredNewline(text);
  const outputOffset = findOutputBlockOffset(text);

  if (outputOffset >= 0) {
    const beforeOutput = text.slice(0, outputOffset).replace(/[ \t]*$/, "");
    const outputAndAfter = text.slice(outputOffset);
    const separator = beforeOutput.length === 0 || beforeOutput.endsWith(newline) ? "" : newline;
    return `${beforeOutput}${separator}${ONLY_THIS_MARKER}${newline}${outputAndAfter}`;
  }

  return text.length === 0 ? `${ONLY_THIS_MARKER}${newline}` : `${ONLY_THIS_MARKER}${newline}${text}`;
}

function removeFirstOnlyThisMarkerBeforeOutput(text: string): string {
  const outputOffset = findOutputBlockOffset(text);
  const prefix = outputOffset >= 0 ? text.slice(0, outputOffset) : text;
  const suffix = outputOffset >= 0 ? text.slice(outputOffset) : "";
  const lines = prefix.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  let offset = 0;

  for (const rawLine of lines) {
    if (rawLine.length === 0 && offset >= prefix.length) break;

    const withoutNewline = rawLine.replace(/\r?\n$|\r$/, "");
    if (withoutNewline.trim() === ONLY_THIS_MARKER) {
      return `${prefix.slice(0, offset)}${prefix.slice(offset + rawLine.length)}${suffix}`;
    }

    offset += rawLine.length;
  }

  return text;
}

async function addTemporaryOnlyThisMarker(uri: vscode.Uri): Promise<boolean> {
  const filePath = uri.fsPath;
  const activeMarkerCount = temporaryOnlyThisMarkers.get(filePath);
  if (activeMarkerCount !== undefined) {
    temporaryOnlyThisMarkers.set(filePath, activeMarkerCount + 1);
    return true;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty && !(await document.save())) {
    throw new Error("Could not save the CPL test file before adding ONLY_THIS.");
  }

  const text = fs.readFileSync(filePath, "utf8");
  if (hasOnlyThisMarkerBeforeOutput(text)) return false;

  fs.writeFileSync(filePath, insertOnlyThisMarker(text), "utf8");
  temporaryOnlyThisMarkers.set(filePath, 1);
  return true;
}

function removeTemporaryOnlyThisMarker(filePath: string): void {
  const activeMarkerCount = temporaryOnlyThisMarkers.get(filePath);
  if (activeMarkerCount === undefined) return;

  if (activeMarkerCount > 1) {
    temporaryOnlyThisMarkers.set(filePath, activeMarkerCount - 1);
    return;
  }

  temporaryOnlyThisMarkers.delete(filePath);

  try {
    const text = fs.readFileSync(filePath, "utf8");
    const cleaned = removeFirstOnlyThisMarkerBeforeOutput(text);
    if (cleaned !== text) fs.writeFileSync(filePath, cleaned, "utf8");
  } catch {}
}

async function runModuleTest(resource?: vscode.Uri): Promise<void> {
  const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    void vscode.window.showErrorMessage("Open a CPL test file before running module tests.");
    return;
  }

  if (path.extname(uri.fsPath) !== ".cpl") {
    void vscode.window.showErrorMessage("CPL module tests can be run only for .cpl files.");
    return;
  }

  const testsDir = findTestsDirUpwards(uri.fsPath);
  if (!testsDir) {
    void vscode.window.showErrorMessage("Could not find tests/module_testing.py above the selected file.");
    return;
  }

  let insertedOnlyThis = false;
  try {
    insertedOnlyThis = await addTemporaryOnlyThisMarker(uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const execution = new vscode.ShellExecution(
    "python3",
    ["module_testing.py", "--path", uri.fsPath],
    { cwd: testsDir }
  );

  const task = new vscode.Task(
    { type: "cpl", command: "runModuleTest", file: uri.fsPath },
    workspaceFolder ?? vscode.TaskScope.Workspace,
    "Run CPL Module Test",
    "CPL",
    execution,
    []
  );
  task.group = vscode.TaskGroup.Test;
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true
  };

  let taskExecution: vscode.TaskExecution;
  try {
    taskExecution = await vscode.tasks.executeTask(task);
  } catch (error) {
    if (insertedOnlyThis) removeTemporaryOnlyThisMarker(uri.fsPath);
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Could not run CPL module test: ${message}`);
    return;
  }

  if (insertedOnlyThis) {
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== taskExecution) return;
      disposable.dispose();
      removeTemporaryOnlyThisMarker(uri.fsPath);
    });
  }
}

type ContainerMethodPrototype = {
  containerName: string;
  methodName: string;
  annotations: string[];
  modifiers: string[];
  params: string;
  returnType: string;
  key: string;
};

type ContainerDeclarationInfo = {
  name: string;
  isInterface: boolean;
  baseNames: string[];
  methods: ContainerMethodPrototype[];
  openOffset?: number;
  closeOffset?: number;
};

function maskCplCommentsAndStrings(text: string): string {
  const chars = text.split("");

  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };

  for (let i = 0; i < text.length;) {
    if (text.startsWith("::", i)) {
      i += 2;
      continue;
    }

    if (text.startsWith(":/", i)) {
      const end = text.indexOf("/:", i + 2);
      const stop = end >= 0 ? end + 2 : text.length;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (text[i] === ":") {
      const end = text.indexOf(":", i + 1);
      if (end >= 0) {
        blank(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "\"" || text[i] === "'") {
      const quote = text[i];
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        if ((text[i] === "\n" || text[i] === "\r") && quote === "'") break;
        i++;
      }
      blank(start, i);
      continue;
    }

    i++;
  }

  return chars.join("");
}

function findMatchingBrace(text: string, openOffset: number): number {
  let depth = 1;
  for (let i = openOffset + 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function normalizeSignaturePart(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function implementationKey(containerName: string, methodName: string, params: string): string {
  return `${containerName}::${methodName}(${normalizeSignaturePart(params)})`;
}

function extractContainerDeclarations(text: string): ContainerDeclarationInfo[] {
  const masked = maskCplCommentsAndStrings(text);
  const declarations: ContainerDeclarationInfo[] = [];
  const containerPattern = /\b(container|interface)\s+([A-Za-z_]\w*)(?:\s*(?:::|implements)\s*([^{]+?))?\s*\{/g;
  let containerMatch: RegExpExecArray | null;

  while ((containerMatch = containerPattern.exec(masked)) !== null) {
    const isInterface = containerMatch[1] === "interface";
    const containerName = containerMatch[2];
    const baseNames = (containerMatch[3] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z_]\w*$/.test(item));
    const openOffset = masked.indexOf("{", containerMatch.index);
    if (openOffset < 0) continue;

    const closeOffset = findMatchingBrace(masked, openOffset);
    if (closeOffset < 0) continue;

    const body = masked.slice(openOffset + 1, closeOffset);
    const methods: ContainerMethodPrototype[] = [];
    const methodPattern = /((?:@\[[^\]]+\]\s*)*)\b((?:(?:glob|ro|extern)\s+)*)function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^;{}]+))?;/g;
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodPattern.exec(body)) !== null) {
      const rawModifiers = methodMatch[2].trim().split(/\s+/).filter(Boolean);
      if (rawModifiers.includes("extern")) continue;

      const methodName = methodMatch[3];
      const modifiers = rawModifiers.filter((modifier) => modifier !== "extern");
      const params = normalizeSignaturePart(methodMatch[4]);
      const returnType = normalizeSignaturePart(methodMatch[5] ?? "i0");

      methods.push({
        containerName,
        methodName,
        annotations: [],
        modifiers,
        params,
        returnType,
        key: implementationKey(containerName, methodName, params)
      });
    }

    declarations.push({ name: containerName, isInterface, baseNames, methods, openOffset, closeOffset });
    containerPattern.lastIndex = closeOffset + 1;
  }

  return declarations;
}

function rewriteInterfaceSelfParam(params: string, containerName: string): string {
  return params.replace(/^ptr\s+[A-Za-z_]\w*\s+self\b/, `ptr ${containerName} self`);
}

function interfaceContractImplementations(
  declarations: ContainerDeclarationInfo[],
  containerName: string
): ContainerMethodPrototype[] {
  const byName = new Map<string, ContainerDeclarationInfo>();
  for (const declaration of declarations) byName.set(declaration.name, declaration);

  const container = byName.get(containerName);
  if (!container || container.isInterface) return [];

  const out: ContainerMethodPrototype[] = [];
  const visit = (interfaceName: string, seen: Set<string>) => {
    if (seen.has(interfaceName)) return;
    seen.add(interfaceName);

    const iface = byName.get(interfaceName);
    if (!iface?.isInterface) return;

    for (const baseName of iface.baseNames) visit(baseName, seen);

    for (const method of iface.methods) {
      const params = rewriteInterfaceSelfParam(method.params, containerName);
      out.push({
        containerName,
        methodName: method.methodName,
        annotations: ["override"],
        modifiers: method.modifiers,
        params,
        returnType: method.returnType,
        key: implementationKey(containerName, method.methodName, params)
      });
    }
  };

  for (const baseName of container.baseNames) visit(baseName, new Set<string>());
  return out;
}

function extractImplementedMethodKeys(text: string): Set<string> {
  const masked = maskCplCommentsAndStrings(text);
  const keys = new Set<string>();
  const methodPattern = /\b(?:(?:glob|ro)\s+)*function\s+([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^{;]+))?\{/g;
  let match: RegExpExecArray | null;

  while ((match = methodPattern.exec(masked)) !== null) {
    keys.add(implementationKey(match[1], match[2], match[3]));
  }

  return keys;
}

function readWorkspaceText(filePath: string): string | undefined {
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === "file" && document.uri.fsPath === filePath
  );
  if (openDocument) return openDocument.getText();

  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function addHeaderCandidate(candidates: Map<string, string>, filePath: string): void {
  const text = readWorkspaceText(filePath);
  if (text !== undefined) candidates.set(filePath, text);
}

function findHeaderCandidatesForDocument(document: vscode.TextDocument): Map<string, string> {
  const candidates = new Map<string, string>();
  if (document.uri.scheme !== "file") return candidates;

  const filePath = document.uri.fsPath;
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  candidates.set(filePath, document.getText());

  const includePattern = /^[ \t]*#[ \t]*include[ \t]+"([^"]+)"/gm;
  let includeMatch: RegExpExecArray | null;

  while ((includeMatch = includePattern.exec(document.getText())) !== null) {
    const includePath = path.resolve(dir, includeMatch[1]);
    if (includePath.endsWith(".cpl") || includePath.endsWith(".inc")) addHeaderCandidate(candidates, includePath);
  }

  if (baseName.endsWith("_h.cpl")) {
    return candidates;
  }

  if (baseName.endsWith(".inc")) {
    return candidates;
  }

  if (baseName.endsWith(".cpl")) {
    const stem = baseName.slice(0, -".cpl".length);
    addHeaderCandidate(candidates, path.join(dir, `${stem}_h.cpl`));
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".inc")) {
          addHeaderCandidate(candidates, path.join(dir, entry.name));
        }
      }
    } catch {}
  }

  return candidates;
}

function findMissingImplementations(
  document: vscode.TextDocument,
  containerName: string
): ContainerMethodPrototype[] {
  const existingKeys = extractImplementedMethodKeys(document.getText());
  const prototypesByKey = new Map<string, ContainerMethodPrototype>();
  const declarations: ContainerDeclarationInfo[] = [];

  for (const headerText of findHeaderCandidatesForDocument(document).values()) {
    declarations.push(...extractContainerDeclarations(headerText));
  }

  for (const declaration of declarations) {
    if (declaration.name !== containerName || declaration.isInterface) continue;
    for (const prototype of declaration.methods) {
      if (prototype.containerName !== containerName) continue;
      if (existingKeys.has(prototype.key)) continue;
      if (!prototypesByKey.has(prototype.key)) prototypesByKey.set(prototype.key, prototype);
    }
  }

  for (const prototype of interfaceContractImplementations(declarations, containerName)) {
    if (existingKeys.has(prototype.key)) continue;
    if (!prototypesByKey.has(prototype.key)) prototypesByKey.set(prototype.key, prototype);
  }

  return [...prototypesByKey.values()];
}

function buildMethodImplementation(prototype: ContainerMethodPrototype): string {
  const annotations = prototype.annotations
    .filter((annotation) => annotation === "override")
    .map((annotation) => `@[${annotation}]`);
  const modifierPrefix = prototype.modifiers.length ? `${prototype.modifiers.join(" ")} ` : "";
  const signature = `${modifierPrefix}function ${prototype.containerName}::${prototype.methodName}(${prototype.params}) -> ${prototype.returnType} {\n}`;
  return annotations.length ? `${annotations.join(" ")}\n${signature}}` : `${signature}}`;
}

function buildMethodImplementations(prototypes: ContainerMethodPrototype[]): string {
  return prototypes.map(buildMethodImplementation).join("\n\n");
}

function buildContainerMethodPrototype(prototype: ContainerMethodPrototype, indent: string): string {
  const annotations = prototype.annotations
    .filter((annotation) => annotation === "override")
    .map((annotation) => `${indent}@[${annotation}]`);
  const modifierPrefix = prototype.modifiers.length ? `${prototype.modifiers.join(" ")} ` : "";
  const signature = `${indent}${modifierPrefix}function ${prototype.methodName}(${prototype.params}) -> ${prototype.returnType};`;
  return annotations.length ? `${annotations.join("\n")}\n${signature}` : signature;
}

function buildContainerMethodPrototypes(
  prototypes: ContainerMethodPrototype[],
  indent: string,
  newline: string
): string {
  return prototypes.map((prototype) => buildContainerMethodPrototype(prototype, indent)).join(`${newline}${newline}`);
}

function implementationCompletionRange(
  document: vscode.TextDocument,
  position: vscode.Position
): { containerName: string; partialMethodName: string; range: vscode.Range } | undefined {
  const line = document.lineAt(position.line);
  const beforeCursor = line.text.slice(0, position.character);
  const match = beforeCursor.match(/^(\s*)((?:(?:glob|ro)\s+)?function\s+)([A-Za-z_]\w*)::([A-Za-z_]\w*)?$/);
  if (!match) return undefined;

  const afterCursor = line.text.slice(position.character);
  const rangeEnd = afterCursor.trim() === "" ? line.range.end : position;
  return {
    containerName: match[3],
    partialMethodName: match[4] ?? "",
    range: new vscode.Range(new vscode.Position(position.line, match[1].length), rangeEnd)
  };
}

function createImplementationCompletionProvider(): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    { language: "cpl", scheme: "file" },
    {
      provideCompletionItems(document, position) {
        const completionContext = implementationCompletionRange(document, position);
        if (!completionContext) return undefined;

        const missing = findMissingImplementations(document, completionContext.containerName);
        if (missing.length === 0) return undefined;

        const items: vscode.CompletionItem[] = [];
        const allItem = new vscode.CompletionItem(
          `Generate all missing ${completionContext.containerName} methods`,
          vscode.CompletionItemKind.Snippet
        );
        allItem.detail = `${missing.length} method${missing.length === 1 ? "" : "s"}`;
        allItem.sortText = "0000";
        allItem.textEdit = vscode.TextEdit.replace(
          completionContext.range,
          buildMethodImplementations(missing)
        );
        items.push(allItem);

        for (const prototype of missing) {
          if (
            completionContext.partialMethodName &&
            !prototype.methodName.startsWith(completionContext.partialMethodName)
          ) {
            continue;
          }

          const item = new vscode.CompletionItem(prototype.methodName, vscode.CompletionItemKind.Method);
          item.detail = `${prototype.methodName}(${prototype.params}) -> ${prototype.returnType}`;
          item.sortText = `1_${prototype.methodName}`;
          item.textEdit = vscode.TextEdit.replace(
            completionContext.range,
            buildMethodImplementation(prototype)
          );
          items.push(item);
        }

        return new vscode.CompletionList(items, false);
      }
    },
    ":"
  );
}

function missingImplementationContainerName(diagnostic: vscode.Diagnostic): string | undefined {
  const message = diagnostic.message;
  return message.match(/^Container '([A-Za-z_]\w*)' must implement inherited abstract method /)?.[1];
}

function declarationsForDocument(document: vscode.TextDocument): ContainerDeclarationInfo[] {
  const declarations: ContainerDeclarationInfo[] = [];
  for (const headerText of findHeaderCandidatesForDocument(document).values()) {
    declarations.push(...extractContainerDeclarations(headerText));
  }
  return declarations;
}

function findCurrentContainerDeclaration(
  document: vscode.TextDocument,
  containerName: string
): ContainerDeclarationInfo | undefined {
  return extractContainerDeclarations(document.getText()).find(
    (declaration) => declaration.name === containerName && !declaration.isInterface
  );
}

function findMissingContainerPrototypes(
  document: vscode.TextDocument,
  containerName: string
): ContainerMethodPrototype[] {
  const declarations = declarationsForDocument(document);
  const container = declarations.find((declaration) => declaration.name === containerName && !declaration.isInterface);
  if (!container) return [];

  const existingPrototypeKeys = new Set(container.methods.map((method) => method.key));
  const prototypesByKey = new Map<string, ContainerMethodPrototype>();

  for (const prototype of interfaceContractImplementations(declarations, containerName)) {
    if (existingPrototypeKeys.has(prototype.key)) continue;
    if (!prototypesByKey.has(prototype.key)) prototypesByKey.set(prototype.key, prototype);
  }

  return [...prototypesByKey.values()];
}

function containerPrototypeInsertPosition(document: vscode.TextDocument, container: ContainerDeclarationInfo): vscode.Position | undefined {
  if (container.closeOffset == null) return undefined;
  return document.positionAt(container.closeOffset);
}

function containerPrototypeInsertText(
  document: vscode.TextDocument,
  container: ContainerDeclarationInfo,
  prototypes: ContainerMethodPrototype[]
): string {
  const text = document.getText();
  const newline = preferredNewline(text);
  const insertPosition = containerPrototypeInsertPosition(document, container);
  const closeLine = insertPosition ? document.lineAt(insertPosition.line) : undefined;
  const baseIndent = closeLine?.text.match(/^[ \t]*/)?.[0] ?? "";
  const memberIndent = `${baseIndent}\t`;
  const body = buildContainerMethodPrototypes(prototypes, memberIndent, newline);
  const insertOffset = insertPosition ? document.offsetAt(insertPosition) : 0;
  const lineStart = insertPosition ? document.offsetAt(new vscode.Position(insertPosition.line, 0)) : insertOffset;
  const beforeClose = text.slice(0, insertOffset);
  const beforeCloseOnLine = text.slice(lineStart, insertOffset);
  const needsLeadingBlankLine =
    beforeCloseOnLine.trim().length > 0 || !beforeClose.trimEnd().endsWith("{")
      ? newline
      : "";

  return `${needsLeadingBlankLine}${body}${newline}${baseIndent}`;
}

function createImplementationCodeActionProvider(): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(
    { language: "cpl", scheme: "file" },
    {
      provideCodeActions(document, _range, context) {
        const actions: vscode.CodeAction[] = [];
        const seenContainers = new Set<string>();

        for (const diagnostic of context.diagnostics) {
          const containerName = missingImplementationContainerName(diagnostic);
          if (!containerName || seenContainers.has(containerName)) continue;
          seenContainers.add(containerName);

          const container = findCurrentContainerDeclaration(document, containerName);
          if (!container) continue;

          const insertPosition = containerPrototypeInsertPosition(document, container);
          if (!insertPosition) continue;

          const missing = findMissingContainerPrototypes(document, containerName);
          if (missing.length === 0) continue;

          const title = missing.length === 1
            ? `Declare missing ${containerName} override`
            : `Declare ${missing.length} missing ${containerName} overrides`;
          const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diagnostic];
          action.isPreferred = true;
          action.edit = new vscode.WorkspaceEdit();
          action.edit.insert(
            document.uri,
            insertPosition,
            containerPrototypeInsertText(document, container, missing)
          );
          actions.push(action);
        }

        return actions;
      }
    },
    {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    }
  );
}

function inferSysTypeForDocument(document: vscode.TextDocument): CplSysType {
  const makefilePath = findMakefileUpwards(document.uri.fsPath);
  if (makefilePath) {
    const vars = parseMakefileVars(makefilePath);
    const runArgsRaw = vars.get("RUN_ARGS");
    if (runArgsRaw) {
      const inferred = inferSysTypeFromCompilerArgs(expandMakeValue(runArgsRaw, vars));
      if (inferred) return inferred;
    }
  }

  return defaultSysTypeForHost(process.platform);
}

function inactivePreprocessorRanges(document: vscode.TextDocument): vscode.Range[] {
  const targetMacro = sysTypeToPredefinedMacro(inferSysTypeForDocument(document));
  const defined = new Set<string>();
  if (targetMacro) defined.add(targetMacro.name);

  const ranges: vscode.Range[] = [];
  const activeStack: boolean[] = [];
  let inactiveDepth = 0;
  let inactiveStart: vscode.Position | undefined;

  const isActive = () => activeStack.every(Boolean);

  for (let lineNo = 0; lineNo < document.lineCount; lineNo++) {
    const line = document.lineAt(lineNo);
    const text = line.text;
    const m = text.match(/^\s*#\s*(ifdef|ifndef|endif|define|undef)\b\s*([A-Za-z_]\w*)?/);
    if (!m) continue;

    const directive = m[1];
    const name = m[2];

    if (directive === "ifdef" || directive === "ifndef") {
      const parentActive = isActive();
      const cond = !!name && (directive === "ifdef" ? defined.has(name) : !defined.has(name));
      const branchActive = parentActive && cond;
      activeStack.push(branchActive);

      if (!branchActive) {
        if (inactiveDepth === 0) inactiveStart = new vscode.Position(lineNo, 0);
        inactiveDepth++;
      }

      continue;
    }

    if (directive === "endif") {
      const wasActive = activeStack.pop();
      if (wasActive === false) {
        inactiveDepth = Math.max(0, inactiveDepth - 1);
        if (inactiveDepth === 0 && inactiveStart) {
          ranges.push(new vscode.Range(inactiveStart, line.rangeIncludingLineBreak.end));
          inactiveStart = undefined;
        }
      }
      continue;
    }

    if (!isActive() || !name) continue;
    if (directive === "define") {
      if (!defined.has(name)) defined.add(name);
    } else if (directive === "undef") {
      defined.delete(name);
    }
  }

  if (inactiveDepth > 0 && inactiveStart) {
    const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
    ranges.push(new vscode.Range(inactiveStart, lastLine.range.end));
  }

  return ranges;
}

export function activate(context: vscode.ExtensionContext) {
  const inactiveBranchDecoration = vscode.window.createTextEditorDecorationType({
    opacity: "0.45"
  });

  const updateInactiveBranches = (editor?: vscode.TextEditor) => {
    if (!editor || editor.document.languageId !== "cpl") return;
    editor.setDecorations(inactiveBranchDecoration, inactivePreprocessorRanges(editor.document));
  };

  const updateVisibleInactiveBranches = () => {
    for (const editor of vscode.window.visibleTextEditors) updateInactiveBranches(editor);
  };

  context.subscriptions.push(
    inactiveBranchDecoration,
    createImplementationCompletionProvider(),
    createImplementationCodeActionProvider(),
    vscode.commands.registerCommand("cpl.runModuleTest", runModuleTest),
    vscode.window.onDidChangeActiveTextEditor((editor) => updateInactiveBranches(editor)),
    vscode.window.onDidChangeVisibleTextEditors(() => updateVisibleInactiveBranches()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) updateInactiveBranches(editor);
      }
    })
  );
  updateVisibleInactiveBranches();

  const keywords = [
    "start","exit","function","container","interface","implements","return",
    "defer","if","else","while","loop","switch","case","default",
    "glob","ro","dref","ref","ptr","lis","break","extern","from","import","syscall","asm","as",
    "f64","f32","i64","i32","i16","i8","u64","u32","u16","u8","i0","str","arr","not","neg","poparg","sizeof","place","section","align"
  ];

  const integerTypeDoc = (name: string, bits: number, signed: boolean) => {
    const bytes = bits / 8;
    const range = signed
      ? `from -2^${bits - 1} to 2^${bits - 1} - 1`
      : `from 0 to 2^${bits} - 1`;

    return `**${name}** - ${signed ? "signed" : "unsigned"} ${bits}-bit integer.

**Memory model**

- Occupies exactly ${bytes} byte${bytes === 1 ? "" : "s"}.
- Value range: ${range}.
- The signed and unsigned types use the same number of bits. They differ in how those bits are interpreted.

\`\`\`cpl
${name} value = 10;
u64 bytes = sizeof(${name}); : ${bytes} :
\`\`\`

**System-level note**

A cast to a narrower integer can discard high bits. A cast between signed and unsigned types preserves the bit pattern only when the compiler's conversion rules permit it, but changes its numerical interpretation. Do not use a small integer type for an address. Use \`ptr T\` instead.`;
  };

  const floatTypeDoc = (name: string, bits: number) => `**${name}** - ${bits}-bit floating-point value.

**Memory model**

- Occupies ${bits / 8} bytes.
- Stores an approximation of a real number, not an exact decimal fraction.
- Very large and very small values, infinities and NaN may be representable depending on the target backend.

\`\`\`cpl
${name} x = 0.1;
${name} y = 0.2;
${name} sum = x + y;
\`\`\`

**Typical pitfall**

Do not compare results of non-trivial floating-point calculations as if every decimal value were exact. Integer types are preferable for counters, sizes, offsets and bit masks.`;

  const docs: Record<string, string> = {
    // Entry points and functions
    start: `**start** - optional program entry point.

The runtime transfers control to \`start\` after the executable has been loaded. Local variables declared inside it normally have automatic lifetime and disappear when the function finishes.

\`\`\`cpl
start(i64 argc, ptr u64 argv) {
  : argc - number of command-line arguments :
  : argv - pointer to an array of argument pointers :
  exit 0;
}
\`\`\`

**System-level view**

The exact initial register and stack state is target-specific. The compiler or runtime converts that platform entry state into the declared CPL parameters. Returning from \`start\` and executing \`exit\` are not necessarily the same operation. \`exit\` explicitly terminates the process.`,

    function: `**function** - declares or defines executable code.

A function has a name, parameters, an optional return type and, for a definition, a body. Parameters are local names whose values are supplied by the caller.

\`\`\`cpl
function abs(i32 x) -> i32 {
  if x < 0; { return x * -1; }
  return x;
}
\`\`\`

Container-associated functions use a qualified name:

\`\`\`cpl
function node::new(i32 value) -> node {
  node result;
  result.value = value;
  return result;
}
\`\`\`

**Call model**

At machine level, a call transfers control to another address and follows a calling convention. The convention defines where arguments and the result are placed, which registers must be preserved and who restores the stack. Declarations used across compilation units must agree exactly on parameter and return types.

**Typical pitfalls**

- Returning a pointer to a local variable creates a dangling pointer after the function ends.
- A declaration and definition with different signatures describe incompatible ABIs.
- Recursive functions consume stack space for every active call.`,

    container: `**container** - a struct-like aggregate containing fields and methods.

Each instance owns storage for its fields. Methods do not occupy space inside each instance. Their machine code is stored separately.

\`\`\`cpl
container storage {
  u32 wood;
  u64 money;

  @[self]
  function sell_wood() -> i0 {
    self.wood -= 100;
    self.money += 100;
  }

  glob function load(ptr u8 source) -> storage;
}

function storage::load(ptr u8 source) -> storage {
  storage result;
  return result;
}
\`\`\`

Use \`.\` for an instance operation and \`::\` for an associated function name.

**Memory layout**

A container's size depends on its fields, their order, alignment and layout annotations. Padding bytes can be inserted between fields or at the end. Therefore the size is not always the sum of field sizes.

- \`@[like_c]\` requests C-like field alignment.
- \`@[union]\` overlays fields at the same starting address, so the size is based on the largest field.
- \`@[align(N)]\` changes the required alignment.

Use \`sizeof(ContainerName)\` to inspect the computed size for the selected target.

**Typical pitfalls**

- Reordering fields can change the binary layout and break file, network or FFI compatibility.
- A pointer to a container is only an address. It does not copy the object.
- A container copied by value may copy padding and every field.`,

    interface: `**interface** - declares a method contract implemented by containers.

Interfaces describe behavior, not stored data. An interface can inherit one or more other interfaces, and a container can list multiple interfaces after \`implements\`.

\`\`\`cpl
interface drawable {
  @[self] @[abstract]
  function draw(ptr drawable self) -> i0;
}

container sprite implements drawable {
  @[override]
  function draw(ptr sprite self) -> i0;
}
\`\`\`

Fields inside an interface are invalid; use a container for stored state.`,

    implements: `**implements** - connects a container or interface to interface contracts.

\`\`\`cpl
interface readable {
  @[self] @[abstract]
  function read(ptr readable self) -> i32;
}

container file_reader implements readable {
  @[override]
  function read(ptr file_reader self) -> i32;
}
\`\`\`

A container that implements an interface must provide matching \`@[override]\` methods. Implementing an interface enables virtual dispatch through pointers to that interface.`,

    return: `**return** - finishes the current function and optionally supplies a result to its caller.

\`\`\`cpl
function id(i32 x) -> i32 {
  return x;
}

function noop() -> i0 {
  return;
}
\`\`\`

**System-level view**

The result is placed according to the target calling convention, often in a register for small scalar values. Larger containers may be returned through hidden memory supplied by the caller.

A returned pointer must remain valid after the function ends. Pointers to local variables generally do not.`,

    defer: `**defer** - schedules a function call to run before the current function leaves.

Syntax: \`defer <function-call>;\`

\`\`\`cpl
function close_file(ptr i0 file) -> i0;

function read_header(ptr i0 file) -> i32 {
  defer close_file(file);
  if file == 0; { return -1; }
  return 0;
}
\`\`\`

Use \`defer\` for local cleanup paths such as releasing memory, closing handles or restoring temporary state. The deferred expression must be a function call.

A deferred call belongs to the current function. It should run before normal \`return\` paths and before explicit \`exit\` statements emitted from that function. Keep deferred calls small and avoid hiding important control flow inside them.`,

    // Control flow
    if: `**if** - executes a block only when its condition is non-zero.

Syntax: \`if <expression>; <block> [else <block>]\`

\`\`\`cpl
if count == 0; {
  exit 1;
} else {
  count -= 1;
}
\`\`\`

The condition is evaluated before the branch is selected. At machine level this commonly becomes a comparison followed by a conditional jump.

**Typical pitfall**

A pointer value can be used as a condition, but that only checks whether the address is zero. It does not prove that the pointed memory is valid.`,

    else: `**else** - alternative branch of an \`if\` statement.

It runs only when the preceding \`if\` condition is zero.

\`\`\`cpl
if ptr_value == 0; {
  exit 1;
} else {
  dref ptr_value = 42;
}
\`\`\`

Keep the null check and dereference in a control-flow relation the reader can see. Low-level code becomes dangerous when pointer validity is only an undocumented assumption.`,

    while: `**while** - repeats a block while its condition remains non-zero.

Syntax: \`while <expression>; <block>\`

\`\`\`cpl
i32 i = 0;
while i < 10; {
  i += 1;
}
\`\`\`

The condition is checked before every iteration. The body may therefore execute zero times.

**System-level note**

A loop over memory should maintain an explicit invariant: current pointer, remaining element count and valid bounds. Pointer arithmetic without a bound can silently walk into unrelated memory.`,

    loop: `**loop** - unconditional repetition.

\`\`\`cpl
loop {
  lis "tick";
  break;
}
\`\`\`

This is useful for event loops, kernels and retry logic. It requires an explicit \`break\`, \`return\`, \`exit\` or another control transfer to terminate.

An infinite busy loop continuously consumes a processor core unless it performs a blocking operation or waits using platform-specific instructions.`,

    switch: `**switch** - selects one branch by comparing a value with \`case\` labels.

\`\`\`cpl
switch(opcode) {
  case 0; { result = 10; }
  case 1; { result = 20; }
  default { result = 0; }
}
\`\`\`

A compiler may lower a dense set of integer cases to a jump table and a sparse set to comparisons. A jump table trades memory for faster branch selection.

Use \`default\` when values outside the known cases are possible, especially for data read from files, devices or the network.`,

    case: `**case** - labels a value-specific branch inside \`switch\`.

\`\`\`cpl
switch(code) {
  case 10; { return 1; }
  case 20; { return 2; }
}
\`\`\`

Case values should be compile-time constants. Keep them unique. Whether execution can fall through to the next case is language-specific, so use explicit blocks and control flow rather than relying on C habits.`,

    default: `**default** - fallback branch of a \`switch\`.

\`\`\`cpl
switch(code) {
  case 0; { return 0; }
  default { return -1; }
}
\`\`\`

In systems code, a default branch is often the place to reject unsupported opcodes, enum values or protocol versions. Silently accepting an unknown value can hide corrupted or hostile input.`,

    break: `**break** - exits the nearest active \`while\`, \`loop\` or \`switch\`.

\`\`\`cpl
while index < count; {
  if data[index] == 0; { break; }
  index += 1;
}
\`\`\`

\`break\` changes control flow only. It does not automatically free manually managed memory or close operating-system resources.`,

    // Storage and linkage
    glob: `**glob** - gives a variable or function global storage/linkage.

\`\`\`cpl
glob i32 counter = 0;
glob function checksum(ptr u8 data, u64 size) -> u32;
\`\`\`

Inside a container, a global function declaration can describe a separately implemented associated function:

\`\`\`cpl
container image {
  glob function load(ptr u8 path) -> image;
}

function image::load(ptr u8 path) -> image {
  image result;
  return result;
}
\`\`\`

**Lifetime and linking**

A global variable exists for the lifetime of the program rather than for one function call. A globally visible symbol can be resolved by the linker from another object file or library.

**Typical pitfalls**

- Mutable global state creates hidden dependencies and is unsafe under concurrency without synchronization.
- Defining the same global symbol in multiple linked units can cause a duplicate-symbol error.
- A global declaration without a matching definition remains an unresolved linker symbol.`,

    ro: `**ro** - read-only storage.

\`\`\`cpl
ro u32 sector_size = 512;
ro str greeting = "Hello";
\`\`\`

The compiler rejects ordinary writes through the read-only name. Depending on the backend and linkage, global read-only data may be placed in a non-writable executable section.

**Important limitation**

Read-only binding and deep immutability are different. A read-only pointer cannot necessarily modify the pointer variable, but the memory reached through that pointer may still be writable unless the type system expresses otherwise.`,

    extern: `**extern** - declares a symbol whose implementation or storage is provided outside the current CPL unit.

\`\`\`cpl
@[abi]
extern function printf(ptr i8 format, ...);

extern ptr u8 frame_buffer;
\`\`\`

The declaration lets the compiler type-check uses and emit a symbol reference. The linker later connects that reference to an object file, static library or shared library.

**ABI requirements**

The CPL declaration must match the external implementation in parameter types, return type, symbol name, calling convention and data layout. A mismatch can compile successfully and still corrupt registers, the stack or memory at runtime.

For C++ implementations, export a stable C symbol with \`extern "C"\` unless CPL deliberately supports C++ name mangling.`,

    // Modules and preprocessing
    from: `**from** - names a source or module from which declarations are imported.

\`\`\`cpl
from "math.cpl" import add, sub
\`\`\`

This is a frontend-level dependency. It is different from \`extern\`: importing makes CPL declarations available, while \`extern\` describes a symbol that must be resolved during linking. Both may be needed when an interface file describes a native library.`,

    import: `**import** - selects names from a \`from\` source.

\`\`\`cpl
from "math.cpl" import add, sub
\`\`\`

Import only the interface needed by the current unit. Explicit imports make symbol ownership and dependencies easier to understand than relying on hidden global declarations.`,

    section: `**section** - places top-level declarations into a named binary section.

\`\`\`cpl
section(".text.fast") {
  function fast_path() -> i32 { return 0; }
}
\`\`\`

Object files are divided into sections such as executable code, read-only data, writable data and zero-initialized storage. A linker script decides where these sections appear in the final address space.

**Typical uses**

- Boot code that must appear at a fixed address.
- Interrupt tables or firmware metadata.
- Separating hot, cold or read-only data.

Section names and their meaning are target- and linker-specific. A wrong placement can make data non-writable, code non-executable or remove it during linking.`,

    align: `**align** - requests alignment for a declaration or declaration block.

Single declaration:

\`\`\`cpl
align(16) i32 value = 0;
\`\`\`

Declaration block:

\`\`\`cpl
align(32) {
  i32 a = 0;
  ptr i8 p = 0;
}
\`\`\`

**What alignment means**

An address aligned to \`N\` is divisible by \`N\`. CPUs and ABIs often require or prefer naturally aligned values. Extra alignment can improve SIMD or device access, but may increase padding and total memory usage.

Alignment is not a size. A 4-byte value aligned to 64 bytes still stores 4 bytes, but its start address obeys the stronger boundary.`,

    // Low-level operations
    syscall: `**syscall** - directly requests a service from the operating-system kernel.

\`\`\`cpl
syscall(0x2000004, 1, ref msg, length);
\`\`\`

**System-level view**

A system call crosses from user mode into the kernel. Its number, arguments, register convention, pointer validity and return/error convention are platform-specific.

**Use with care**

- The same number can mean different operations on Linux, macOS and other systems.
- Every pointer passed to the kernel must reference a valid buffer for the required direction and length.
- A negative or special return value may represent an error rather than useful data.
- Prefer a stable library wrapper when portability matters.`,

    asm: `**asm** - embeds target-specific assembly instructions.

\`\`\`cpl
u64 output = 0;
asm(output) {
  "xor rax, rax",
  "mov rax, 1",
  "mov %0, rax"
}
\`\`\`

Inline assembly bypasses many compiler guarantees. The author must respect the processor ISA, calling convention, register usage, stack alignment and the compiler's operand contract.

**Typical pitfalls**

- Modifying a register the compiler assumes is preserved.
- Reading or writing memory without telling the compiler.
- Depending on one architecture or assembler syntax.
- Forgetting that an optimizer may move surrounding code unless dependencies are represented.

Use ordinary CPL for control flow and arithmetic unless assembly is required for an instruction, ABI boundary or measured performance reason.`,

    lis: `**lis** - debug breakpoint marker or trace hook.

\`\`\`cpl
lis "before device write";
\`\`\`

Its exact generated behavior depends on the compiler/runtime. Treat it as a diagnostic aid, not as program logic. Production behavior should not depend on a debugger being attached.`,

    exit: `**exit** - terminates the current process with an exit status.

\`\`\`cpl
if initialization_failed; {
  exit 1;
}
exit 0;
\`\`\`

By convention, status 0 means success and a non-zero value means failure, although the operating system only preserves a platform-specific portion of the integer.

Immediate process termination may bypass normal function returns and cleanup logic. Flush or close important resources explicitly when required by the runtime.`,

    // Addressing, operators and casts
    ref: `**ref** - obtains the address of an object.

\`\`\`cpl
i32 value = 10;
ptr i32 address = ref value;
dref address = 11;
\`\`\`

**What actually happens**

\`value\` stores the integer itself. \`ref value\` produces the memory address at which that integer is stored. The pointer contains an address, not a second copy of the integer.

\`\`\`text
value storage:   [ 10 ]
                  ^
address ---------+
\`\`\`

**Lifetime rule**

The pointer is valid only while the referenced object still exists and remains at that address. Returning \`ref local_variable\` from a function is generally invalid because the local storage disappears when the function returns.`,

    dref: `**dref** - accesses the object stored at an address.

\`\`\`cpl
i32 value = 10;
ptr i32 address = ref value;

i32 copy = dref address; : load 10 from memory :
dref address = 20;       : store 20 into memory :
\`\`\`

A dereference performs a memory access using the pointer as the address and its target type as the access size and interpretation.

**Safety requirements**

Before dereferencing, the pointer must be non-zero, correctly aligned, point to a live object, allow the requested read or write and cover at least \`sizeof(target_type)\` bytes. A successful null check alone does not prove these conditions.`,

    ptr: `**ptr** - constructs a pointer type.

\`ptr T\` stores the address of a value whose memory is interpreted as type \`T\`.

\`\`\`cpl
i32 value = 42;
ptr i32 p = ref value;
i32 loaded = dref p;
\`\`\`

**Pointer size**

The pointer itself normally occupies one machine word, regardless of the size of \`T\`:

\`\`\`cpl
sizeof(ptr u8);  : 8 on a 64-bit target, 4 on i386 :
sizeof(ptr i64); : same pointer size :
\`\`\`

The target type controls dereference and indexing. It does not allocate memory and does not record the buffer length.

**Null pointer**

A zero pointer represents no object. It may be compared or stored, but dereferencing it is invalid.

\`\`\`cpl
ptr i32 p = 0;
if p == 0; { exit 1; }
\`\`\`

**Pointer arithmetic and indexing**

Indexing conceptually advances by the target type's size. For \`ptr i32 p\`, \`p[1]\` addresses the next \`i32\`, not the next byte. A pointer does not know how many elements are valid, so the programmer must carry a separate count.

**Typed and untyped pointers**

\`ptr i0\` can represent an untyped address at ABI boundaries. Cast it to the correct pointer type before dereferencing. The cast changes the compiler's interpretation of the same address. It does not validate or transform the memory.

**Common invalid states**

- Null pointer.
- Dangling pointer to an object whose lifetime ended.
- Out-of-bounds pointer.
- Misaligned pointer.
- Pointer with the wrong target type.
- Pointer to read-only memory used for a write.`,

    not: `**not** - logical negation.

It converts zero to 1 and a non-zero value to 0.

\`\`\`cpl
i32 a = not 0;  : 1 :
i32 b = not 25; : 0 :
\`\`\`

This is a logical operation, not a bit-by-bit inversion. Use \`neg\` for bit inversion.`,

    neg: `**neg** - bitwise inversion.

Every bit in the operand is flipped.

\`\`\`cpl
u8 mask = 0b00001111;
u8 inverse = neg mask; : 0b11110000 :
\`\`\`

The result depends on the operand width. Inverting an \`u8\` flips 8 bits, while inverting a \`u64\` flips 64 bits. Prefer unsigned types for masks because their bit interpretation is clearer.`,

    poparg: `**poparg** - retrieves a variadic argument according to the CPL calling convention.

\`\`\`cpl
function inspect(...) -> i0 {
  ptr u8 first = poparg as ptr u8;
}
\`\`\`

Variadic arguments carry less type information than normal parameters. The function must know the expected order and types from another argument, a format string or an external protocol.

**ABI warning**

Different types can be passed in different registers or promoted before a call. Reading a variadic argument using the wrong type can consume the wrong bytes or corrupt interpretation of later arguments.`,

    as: `**as** - explicitly converts or reinterprets an expression as another type.

\`\`\`cpl
u64 wide = 255 as u64;
ptr u8 bytes = (ref wide) as ptr u8;
\`\`\`

**Numeric casts**

A wider type can represent more values. A narrower type can discard information. Signedness changes how the same high bit is interpreted.

**Pointer casts**

Casting \`ptr A\` to \`ptr B\` keeps the address and changes the type used for future memory accesses. It does not resize, relocate or validate the object.

\`\`\`cpl
u32 word = 0x11223344;
ptr u8 first_byte = (ref word) as ptr u8;
\`\`\`

The byte observed through \`first_byte\` depends on target endianness. Pointer casts also require correct alignment and sufficient storage for the target type.`,

    sizeof: `**sizeof** - computes the storage size of a type or expression at compile time.

\`\`\`cpl
u64 a = sizeof(i32);       : 4 :
u64 b = sizeof(ptr u8);    : pointer size :
u64 c = sizeof arr[16, u8];: 16 :
u64 d = sizeof(value);    : size of value's type :
\`\`\`

The expression form asks for the expression's type size. It should not read the object or follow a pointer.

**Containers and layout**

For containers, the result includes padding required by the selected layout and annotations. It may therefore exceed the sum of field sizes.

\`\`\`cpl
@[like_c]
container packet {
  u8 tag;
  u32 length;
}

u64 packet_size = sizeof(packet);
\`\`\`

**Important distinction**

\`sizeof(ptr packet)\` is the size of one address. \`sizeof(packet)\` is the size of the complete object. \`sizeof(str)\` describes the string value representation, not the number of characters in the pointed string.`,

    place: `**place** - creates a container object in existing storage.

\`\`\`cpl
@[align(8)] arr storage[64, u8];
ptr impl item = place(ref storage, impl);
\`\`\`

The first argument is the destination address. The second argument is the concrete container type to place there. This is useful for factories, arenas and interface dispatch because the placed object can be used through an implemented interface pointer.

Make sure the storage is large enough for \`sizeof(Container)\` and aligned for the target layout. Virtual containers include vtable storage in their computed size.`,

    // Primitive and aggregate types
    f64: floatTypeDoc("f64", 64),
    f32: floatTypeDoc("f32", 32),
    i64: integerTypeDoc("i64", 64, true),
    i32: integerTypeDoc("i32", 32, true),
    i16: integerTypeDoc("i16", 16, true),
    i8: integerTypeDoc("i8", 8, true),
    u64: integerTypeDoc("u64", 64, false),
    u32: integerTypeDoc("u32", 32, false),
    u16: integerTypeDoc("u16", 16, false),
    u8: integerTypeDoc("u8", 8, false),

    i0: `**i0** - no-value type, analogous to \`void\`.

Use it as the return type of a function that performs an action but does not produce a value.

\`\`\`cpl
function clear(ptr u8 data, u64 size) -> i0 {
  return;
}
\`\`\`

\`ptr i0\` is different. It is a pointer-sized address with no specific target object type. It is useful at ABI boundaries, but it must be cast to a correctly typed pointer before a meaningful dereference.`,

    str: `**str** - string value.

\`\`\`cpl
str message = "Hello";
\`\`\`

In the language server's type model, \`str\` is pointer-sized. The characters occupy separate storage, so \`sizeof(str)\` does not return the string length.

**System-level questions to keep explicit**

- Is the character data mutable or read-only?
- Is it zero-terminated or accompanied by a length?
- Who owns the storage and how long does it remain valid?
- Which encoding is used?

When calling C APIs, many functions expect \`ptr i8\` to zero-terminated bytes. A CPL \`str\` should only be passed when its runtime representation satisfies that ABI.`,

    arr: `**arr** - fixed-size contiguous array.

Declaration form:

\`\`\`cpl
arr buffer[16, u8] = {1, 2, 3};
\`\`\`

Type form:

\`\`\`cpl
arr[16, u8] buffer;
\`\`\`

**Memory layout**

The elements are stored consecutively. For an array of \`N\` elements of type \`T\`, the basic storage size is \`N * sizeof(T)\`.

\`\`\`text
buffer[0] buffer[1] buffer[2] ... buffer[N-1]
\`\`\`

Array indexing uses an element index, not a byte offset. The valid range is 0 through \`N - 1\`.

**Array versus pointer**

An array owns storage for all elements. A pointer stores only an address. Passing an array to low-level code may produce a pointer to its first element, but the pointer no longer carries the array length. Keep the count as a separate value.`,
  };

  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: "cpl", scheme: "file" },
    {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(
          position,
          /0x[0-9a-fA-F]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|'[^']'|[A-Za-z_][A-Za-z0-9_]*/ 
        );
        if (!range) return;
        const word = document.getText(range);        

        if (/^(0x[0-9a-fA-F]+|0b[01]+|0[0-7]*|[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?|'.')$/.test(word)) {
          let value: number;
          let type: string;

          if (word.startsWith("'") && word.endsWith("'")) {
            value = word.charCodeAt(1);
            type = "u8";
          } 
          else if (word.startsWith("0x") || word.startsWith("0X")) {
            value = parseInt(word, 16);
            type = value > 0xFFFFFFFF ? "u64" : value > 0xFFFF ? "u32" : value > 0xFF ? "u16" : "u8";
          } 
          else if (word.startsWith("0b") || word.startsWith("0B")) {
            value = parseInt(word.slice(2), 2);
            type = value > 0xFFFFFFFF ? "u64" : value > 0xFFFF ? "u32" : value > 0xFF ? "u16" : "u8";
          } 
          else if (word.startsWith("0") && word.length > 1 && !word.includes(".")) {
            value = parseInt(word, 8);
            type = value > 0xFFFFFFFF ? "u64" : value > 0xFFFF ? "u32" : value > 0xFF ? "u16" : "u8";
          } 
          else if (word.includes(".") || /[eE]/.test(word)) {
            const f = parseFloat(word);
            type = "f64";
            const buffer = new ArrayBuffer(8);
            new DataView(buffer).setFloat64(0, f, false);
            const high = new DataView(buffer).getUint32(0, false);
            const low = new DataView(buffer).getUint32(4, false);
            const bits = (BigInt(high) << 32n) | BigInt(low);
            value = Number(bits);
          } 
          else {
            value = parseInt(word, 10);
            type = value > 0xFFFFFFFF ? "u64" : value > 0xFFFF ? "u32" : value > 0xFF ? "u16" : "u8";
          }

          const md = new vscode.MarkdownString();
          md.appendMarkdown(`(${type}) ${value}\n\n`);
          md.appendMarkdown(`(${type}) 0x${value.toString(16).toUpperCase()}\n\n`);
          md.appendMarkdown(`(${type}) 0b${value.toString(2)}\n`);
          return new vscode.Hover(md);
        }

        if (docs[word]) return new vscode.Hover(new vscode.MarkdownString(docs[word]));
        if (keywords.includes(word)) return new vscode.Hover(new vscode.MarkdownString(`**${word}**`));
        return;
      }
    }
  );

  context.subscriptions.push(hoverProvider);

  const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "cpl" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.cpl")
    }
  };

  client = new LanguageClient("cplLS", "CPL Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client);
  void client.start();
}

export function deactivate() {
  return client?.stop();
}
