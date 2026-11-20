import { basename } from "node:path";
import ts from "typescript";
import { git } from "../exec.js";
import { detectTestCommand, renderTestCommand, showFile } from "./git-miner.js";
import { TEST_FILE_RE, type MineOptions, type Task } from "./types.js";

/**
 * SWE-smith-style "stub" tasks for repos whose history has few test-changing commits: take a function
 * that the test suite exercises, replace its body with `throw`, hide the tests that cover it, and ask the
 * agent to re-implement it from its signature, doc comment and call sites. The original body is the
 * reference solution, so every task is solvable by construction (still verified by running the tests).
 */

const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs)$/;

interface Decl {
  file: string;
  name: string;
  bodyStart: number;
  bodyEnd: number;
  signature: string;
  hasDoc: boolean;
  statements: number;
}

function resolveModule(fromFile: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const dir = fromFile.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") dir.pop();
    else if (part !== ".") dir.push(part);
  }
  const base = dir.join("/");
  const stem = base.replace(/\.(js|mjs|cjs|jsx|ts)$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, `${base}/index.ts`, `${base}/index.js`];
  return candidates.find((c) => files.has(c));
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function isExported(node: ts.Node): boolean {
  return !!ts.getCombinedModifierFlags(node as ts.Declaration) && (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function declFromBody(file: string, name: string, src: ts.SourceFile, node: ts.Node, body: ts.Block): Decl {
  const text = src.text;
  const sigEnd = body.getStart(src);
  const start = node.getStart(src);
  return {
    file,
    name,
    bodyStart: sigEnd,
    bodyEnd: body.getEnd(),
    signature: text.slice(start, sigEnd).replace(/\s+/g, " ").trim(),
    hasDoc: ts.getJSDocCommentsAndTags(node).length > 0 || /\/\*\*[\s\S]*?\*\/\s*$/.test(text.slice(Math.max(0, node.getFullStart()), start)),
    statements: body.statements.length,
  };
}

/** Find `export function name` / `export const name = (…) => { … }` in a file. */
function findDecl(file: string, src: ts.SourceFile, name: string): Decl | undefined {
  for (const st of src.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body && isExported(st)) {
      return declFromBody(file, name, src, st, st.body);
    }
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const init = d.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body)) {
          return declFromBody(file, name, src, st, init.body);
        }
      }
    }
  }
  return undefined;
}

/** Follow `export { a as b } from "./x.js"` and `export * from` chains to the declaring file. */
async function locate(
  name: string,
  file: string,
  files: Set<string>,
  read: (p: string) => Promise<string | undefined>,
  depth = 0,
): Promise<Decl | undefined> {
  if (depth > 4) return undefined;
  const text = await read(file);
  if (text === undefined) return undefined;
  const src = parse(file, text);
  const direct = findDecl(file, src, name);
  if (direct) return direct;
  for (const st of src.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveModule(file, st.moduleSpecifier.text, files);
    if (!target) continue;
    if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === name) return locate(el.propertyName?.text ?? name, target, files, read, depth + 1);
      }
    } else if (!st.exportClause) {
      const hit = await locate(name, target, files, read, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function stubSource(text: string, decl: Decl): string {
  return `${text.slice(0, decl.bodyStart)}{\n  throw new Error("not implemented: ${decl.name}");\n}${text.slice(decl.bodyEnd)}`;
}

export function stubInstruction(decl: Decl): string {
  return [
    `The function \`${decl.name}\` in \`${decl.file}\` has lost its implementation: its body now only throws "not implemented".`,
    ``,
    `Signature: \`${decl.signature}\``,
    ``,
    `Implement it so it does what its name, signature${decl.hasDoc ? ", doc comment" : ""} and the call sites in this repo expect.`,
    `Do not change its signature or any other exported API. Hidden tests will check its behaviour.`,
  ].join("\n");
}

export interface StubMineOptions extends MineOptions {
  commit?: string;
  /** Minimum statements in a body for it to be a worthwhile task. */
  minStatements?: number;
  minBodyChars?: number;
}

export async function mineStubTasks(repo: string, opts: StubMineOptions = {}): Promise<Task[]> {
  const repoName = basename(repo);
  const commit = (await git(repo, ["rev-parse", opts.commit ?? "HEAD"])).trim();
  const all = (await git(repo, ["ls-tree", "-r", "--name-only", commit], { maxOutput: 50_000_000 })).split("\n").filter(Boolean);
  const files = new Set(all);
  const cache = new Map<string, Promise<string | undefined>>();
  const read = (p: string) => {
    let v = cache.get(p);
    if (!v) cache.set(p, (v = showFile(repo, commit, p)));
    return v;
  };
  const template = opts.testCommand ?? (await detectTestCommand(repo, commit));
  if (!template) return [];

  const testFiles = all.filter((f) => TEST_FILE_RE.test(f) && TS_EXT.test(f) && (!opts.scope || f.startsWith(opts.scope)));
  // symbol key "file#name" → decl + tests that call it
  const found = new Map<string, { decl: Decl; tests: Set<string> }>();
  for (const tf of testFiles) {
    const text = await read(tf);
    if (!text) continue;
    const src = parse(tf, text);
    for (const st of src.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly) continue;
      const mod = resolveModule(tf, st.moduleSpecifier.text, files);
      const named = st.importClause?.namedBindings;
      if (!mod || !named || !ts.isNamedImports(named)) continue;
      for (const el of named.elements) {
        if (el.isTypeOnly) continue;
        const local = el.name.text;
        // Only symbols the test actually calls.
        if (!new RegExp(`\\b${local}\\s*\\(`).test(text.slice(st.getEnd()))) continue;
        const decl = await locate(el.propertyName?.text ?? local, mod, files, read);
        if (!decl) continue;
        if (TEST_FILE_RE.test(decl.file)) continue;
        const key = `${decl.file}#${decl.name}`;
        const slot = found.get(key) ?? { decl, tests: new Set<string>() };
        slot.tests.add(tf);
        found.set(key, slot);
      }
    }
  }

  const minStatements = opts.minStatements ?? 2;
  const minChars = opts.minBodyChars ?? 120;
  const viable = [...found.values()].filter(({ decl }) => decl.statements >= minStatements && decl.bodyEnd - decl.bodyStart >= minChars);
  // Round-robin across files so one big module doesn't dominate the benchmark.
  const byFile = new Map<string, typeof viable>();
  for (const v of viable.sort((a, b) => a.decl.name.localeCompare(b.decl.name))) {
    const l = byFile.get(v.decl.file) ?? [];
    l.push(v);
    byFile.set(v.decl.file, l);
  }
  const ordered: typeof viable = [];
  for (let i = 0; ordered.length < viable.length; i++) {
    for (const l of [...byFile.keys()].sort().map((k) => byFile.get(k)!)) if (l[i]) ordered.push(l[i]!);
  }

  const tasks: Task[] = [];
  for (const { decl, tests } of ordered) {
    if (opts.limit && tasks.length >= opts.limit) break;
    const original = (await read(decl.file))!;
    const testList = [...tests].sort();
    const hiddenTests = [];
    for (const t of testList) hiddenTests.push({ path: t, content: (await read(t))! });
    tasks.push({
      id: `${repoName}-stub-${decl.name}`,
      kind: "stub",
      repoName,
      baseCommit: commit,
      instruction: stubInstruction(decl),
      overlay: [{ path: decl.file, content: stubSource(original, decl) }],
      hiddenTests,
      removeFromWorkspace: [],
      reference: [{ path: decl.file, content: original }],
      testCommand: renderTestCommand(template, testList),
      meta: { symbol: decl.name, file: decl.file, statements: String(decl.statements) },
    });
  }
  return tasks;
}
