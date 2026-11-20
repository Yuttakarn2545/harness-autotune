import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------- synthetic transcripts ----------

let n = 0;
const uid = () => `u-${++n}`;

export interface TBuilder {
  lines: object[];
  human(text: string): TBuilder;
  assistant(opts: { text?: string; tools?: { name: string; input: object; error?: boolean; output?: string }[]; usage?: object; model?: string }): TBuilder;
  jsonl(): string;
}

export function transcript(sessionId = "sess-0001-synthetic"): TBuilder {
  const b: TBuilder = {
    lines: [],
    human(text) {
      b.lines.push({ type: "user", uuid: uid(), sessionId, cwd: "C:\\Work\\demo", origin: { kind: "human" }, message: { role: "user", content: text }, timestamp: "2026-11-01T00:00:00Z" });
      return b;
    },
    assistant({ text, tools = [], usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, model = "claude-opus-5-5" }) {
      const id = `msg_${++n}`;
      // Claude Code writes one line per content block, each repeating message.id and usage.
      if (text) b.lines.push({ type: "assistant", sessionId, message: { id, model, role: "assistant", content: [{ type: "text", text }], usage } });
      for (const t of tools) {
        const tid = `toolu_${++n}`;
        b.lines.push({ type: "assistant", sessionId, message: { id, model, role: "assistant", content: [{ type: "tool_use", id: tid, name: t.name, input: t.input }], usage } });
        b.lines.push({ type: "user", sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, is_error: !!t.error, content: t.output ?? (t.error ? "Error: exit code 1" : "ok") }] } });
      }
      return b;
    },
    jsonl() {
      return b.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    },
  };
  return b;
}

/** A transcript exhibiting every friction category once. */
export function frictionTranscript(): string {
  const t = transcript();
  t.human("add a slugify helper");
  t.assistant({ tools: [{ name: "Read", input: { file_path: "C:\\Work\\demo\\src\\util.ts" } }] });
  t.assistant({ tools: [{ name: "Read", input: { file_path: "C:\\Work\\demo\\src\\util.ts" } }] });
  t.assistant({ tools: [{ name: "Read", input: { file_path: "C:/Work/demo/src/util.ts" } }] });
  t.assistant({ tools: [{ name: "Edit", input: { file_path: "C:\\Work\\demo\\src\\util.ts", old_string: "a", new_string: "b" } }] });
  t.assistant({ text: "Done — slugify is implemented." });
  t.human("no, I said kebab-case, not snake_case");
  t.assistant({ tools: [{ name: "Bash", input: { command: "cd /c/Work/demo && npm run build" }, error: true, output: "error TS2304: Cannot find name 'x'" }] });
  t.assistant({ tools: [{ name: "Bash", input: { command: "npm run build" }, error: true, output: "error TS2304: Cannot find name 'x'" }] });
  t.assistant({ tools: [{ name: "Bash", input: { command: "npm run build 2>&1 | tail" }, error: true, output: "error TS2304" }] });
  t.assistant({ tools: [{ name: "Edit", input: { file_path: "C:\\Work\\demo\\src\\util.ts", old_string: "b", new_string: "c" } }] });
  t.assistant({ tools: [{ name: "Bash", input: { command: "npm test" }, output: "3 passed" }] });
  t.assistant({ text: "Fixed and tests pass." });
  t.human("thanks, now summarize the README");
  t.assistant({ tools: [{ name: "Read", input: { file_path: "README.md" }, output: "x".repeat(30_000) }], usage: { input_tokens: 10, output_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 400_000 } });
  t.assistant({ text: "Here is the summary." });
  return t.jsonl();
}

// ---------- fixture git repo ----------

export function gitIn(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

function put(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

const MATH_V1 = `/** Clamp n into [lo, hi]. Throws if lo > hi. */
export function clamp(n, lo, hi) {
  if (lo > hi) throw new RangeError("lo must be <= hi");
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
`;

const MATH_V2 =
  MATH_V1 +
  `
/** Lower-case, trim, and join words with single dashes. */
export function slugify(text) {
  const words = String(text).toLowerCase().trim().split(/[^a-z0-9]+/);
  const kept = words.filter((w) => w.length > 0);
  return kept.join("-");
}
`;

const TEST_V1 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/math.js";

test("clamp", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.throws(() => clamp(1, 3, 0));
});
`;

const TEST_V2 = TEST_V1.replace('import { clamp } from "../src/math.js";', 'import { clamp, slugify } from "../src/math.js";') +
  `
test("slugify", () => {
  assert.equal(slugify("  Hello, World!  "), "hello-world");
  assert.equal(slugify("a--b"), "a-b");
});
`;

/** Two-commit JS repo: v1 adds clamp + test, v2 adds slugify + its test (a minable git task). */
export function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autotune-fixture-"));
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "core.autocrlf", "false");
  put(dir, {
    "package.json": JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test test/" } }, null, 2),
    "CLAUDE.md": "# Fixture\n\nRun `npm test`.\n",
    "src/math.js": MATH_V1,
    "test/math.test.js": TEST_V1,
  });
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "Add clamp");
  put(dir, { "src/math.js": MATH_V2, "test/math.test.js": TEST_V2 });
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "Add slugify helper\n\nTurn arbitrary text into URL slugs.\n\nCo-Authored-By: Someone <x@y.z>");
  return dir;
}
