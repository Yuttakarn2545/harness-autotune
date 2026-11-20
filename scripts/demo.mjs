// Offline end-to-end demo: no API key, no network, ~30 seconds.
// Builds a tiny git repo, mines sealed tasks from it, runs baseline vs one candidate with the
// *scripted* agent (synthetic behaviour, not a model), and writes the report. The numbers it prints
// demonstrate the pipeline only — they are not measurements of Claude.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  mineGitTasks, mineStubTasks, verifyTask, isUsable, planBench, runBench, BASELINE, ScriptedAgent,
  buildBenchReport, benchMarkdown, benchHtml, renderDiff,
} from "../dist/index.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@localhost", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@localhost" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" });
const put = (root, files) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
};

const repo = join(mkdtempSync(join(tmpdir(), "autotune-demo-")), "demo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
put(repo, {
  "package.json": JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test test/" } }),
  "CLAUDE.md": "# Demo\n",
  "src/text.js": `/** Count words separated by whitespace. */
export function wordCount(s) {
  const parts = String(s).trim().split(/\\s+/);
  const words = parts.filter((p) => p.length > 0);
  return words.length;
}

/** Title-case each word. */
export function titleCase(s) {
  const words = String(s).toLowerCase().split(" ");
  const cased = words.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w));
  return cased.join(" ");
}

/** Reverse the order of words. */
export function reverseWords(s) {
  const words = String(s).trim().split(/\\s+/);
  const reversed = [...words].reverse();
  return reversed.join(" ");
}

/** Truncate to n characters, adding an ellipsis when cut. */
export function truncate(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + "…";
}

/** Count vowels (a, e, i, o, u), case-insensitive. */
export function vowelCount(s) {
  const matches = String(s).toLowerCase().match(/[aeiou]/g);
  const list = matches ?? [];
  return list.length;
}

/** Capitalise only the first character. */
export function capitalize(s) {
  const str = String(s);
  if (!str) return str;
  return str[0].toUpperCase() + str.slice(1);
}

/** Collapse runs of whitespace to one space and trim. */
export function squish(s) {
  const one = String(s).replace(/\\s+/g, " ");
  const trimmed = one.trim();
  return trimmed;
}

/** Repeat s n times joined by sep. */
export function repeatJoin(s, n, sep) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(String(s));
  return parts.join(sep ?? "");
}

/** Longest word (first on ties). */
export function longestWord(s) {
  const words = String(s).split(/\\s+/).filter(Boolean);
  let best = "";
  for (const w of words) if (w.length > best.length) best = w;
  return best;
}

/** Is the string a palindrome, ignoring case and non-letters? */
export function isPalindrome(s) {
  const letters = String(s).toLowerCase().replace(/[^a-z]/g, "");
  const flipped = [...letters].reverse().join("");
  return letters === flipped;
}
`,
  "test/text.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { wordCount, titleCase, reverseWords, truncate, vowelCount, isPalindrome, capitalize, squish, repeatJoin, longestWord } from "../src/text.js";
test("wordCount", () => { assert.equal(wordCount("  a b  c "), 3); assert.equal(wordCount(""), 0); });
test("titleCase", () => { assert.equal(titleCase("hello WORLD"), "Hello World"); });
test("reverseWords", () => { assert.equal(reverseWords(" one two  three "), "three two one"); });
test("truncate", () => { assert.equal(truncate("abcdef", 4), "abc…"); assert.equal(truncate("ab", 4), "ab"); });
test("vowelCount", () => { assert.equal(vowelCount("Education"), 5); assert.equal(vowelCount("xyz"), 0); });
test("capitalize", () => { assert.equal(capitalize("hi there"), "Hi there"); assert.equal(capitalize(""), ""); });
test("squish", () => { assert.equal(squish("  a   b \\n c "), "a b c"); });
test("repeatJoin", () => { assert.equal(repeatJoin("ab", 3, "-"), "ab-ab-ab"); assert.equal(repeatJoin("x", 2), "xx"); });
test("longestWord", () => { assert.equal(longestWord("a bbb cc ddd"), "bbb"); });
test("isPalindrome", () => { assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true); assert.equal(isPalindrome("abc"), false); });
`,
});
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "text helpers");

const mined = [...(await mineGitTasks(repo)), ...(await mineStubTasks(repo, { minBodyChars: 40 }))];
const tasks = [];
for (const t of mined) {
  const v = await verifyTask(t, { sourceRepo: repo });
  console.log(`${isUsable(v) ? "ok  " : "drop"} ${t.id}`);
  if (isUsable(v)) tasks.push(v);
}

const candidate = {
  id: "verify-before-done",
  title: "Run the tests before claiming done",
  rationale: "demo candidate",
  targets: ["unverified-done"],
  edits: [{ file: "CLAUDE.md", mode: "append", content: "## Verification\n\nRun `npm test` before saying you are done." }],
};
// Synthetic behaviour: the scripted agent solves 40% of tasks under baseline, 90% with the candidate.
const agent = new ScriptedAgent((_t, ws) => (readFileSync(join(ws, "CLAUDE.md"), "utf8").includes("Verification") ? 0.9 : 0.4), 0.2);
const out = mkdtempSync(join(tmpdir(), "autotune-demo-out-"));
const plan = planBench(tasks, [BASELINE, { id: candidate.id, candidate }], 4, 0.5);
const records = await runBench(plan, agent, {
  sourceRepo: repo, seeds: 4, heldOutFraction: 0.5, deps: "none", resultsFile: join(out, "results.jsonl"),
  maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 60_000,
});
const diff = renderDiff(new Map([["CLAUDE.md", "# Demo\n"]]), candidate);
const report = buildBenchReport(records, [candidate], { [candidate.id]: diff }, "offline demo (scripted agent — synthetic numbers)");
writeFileSync(join(out, "report.md"), benchMarkdown(report));
writeFileSync(join(out, "report.html"), benchHtml(report));
console.log("\n" + benchMarkdown(report));
console.log(`report: ${join(out, "report.html")}`);
