import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mineGitTasks, instructionFromCommit } from "../src/tasks/git-miner.js";
import { mineStubTasks } from "../src/tasks/stub-miner.js";
import { auditSeal, sealWorkspace } from "../src/tasks/seal.js";
import { isUsable, splitTasks, verifyTask } from "../src/tasks/verify.js";
import { gitIn, makeFixtureRepo } from "./helpers.js";

const repo = makeFixtureRepo();
const headBefore = gitIn(repo, "rev-parse", "HEAD").trim();

describe("git miner", () => {
  it("mines the commit that changed tests and source, with a clean instruction", async () => {
    const tasks = await mineGitTasks(repo);
    expect(tasks).toHaveLength(1); // the root commit has no parent
    const t = tasks[0]!;
    expect(t.kind).toBe("git-commit");
    expect(t.instruction).toContain("Add slugify helper");
    expect(t.instruction).not.toMatch(/Co-Authored-By/i);
    expect(t.hiddenTests.map((h) => h.path)).toEqual(["test/math.test.js"]);
    expect(t.testCommand).toBe("node --test test/math.test.js");
  });

  it("produces a sealed workspace: one orphan commit, no remotes, hidden tests absent", async () => {
    const [t] = await mineGitTasks(repo);
    const ws = await sealWorkspace(t!, { sourceRepo: repo, extraFiles: [{ path: "CLAUDE.md", content: "variant\n" }] });
    try {
      const audit = await auditSeal(ws.dir, t!);
      expect(audit).toEqual({ ok: true, problems: [] });
      const log = gitIn(ws.dir, "log", "--format=%s%x00%an%x00%aI");
      expect(log.trim()).toBe("snapshot\u0000autotune\u00002000-01-01T00:00:00Z");
      expect(log).not.toContain("slugify");
      expect(existsSync(join(ws.dir, "test", "math.test.js"))).toBe(false);
      expect(readFileSync(join(ws.dir, "src", "math.js"), "utf8")).not.toContain("slugify");
      expect(readFileSync(join(ws.dir, "CLAUDE.md"), "utf8")).toBe("variant\n");
    } finally {
      await ws.dispose();
    }
  });

  it("verifies: hidden tests fail at base and pass with the reference", async () => {
    const [t] = await mineGitTasks(repo);
    const v = await verifyTask(t!, { sourceRepo: repo });
    expect(v.verified).toMatchObject({ baseFails: true, referencePasses: true });
    expect(isUsable(v)).toBe(true);
  });

  it("strips trailers but keeps the body", () => {
    const s = instructionFromCommit("Fix x", "Because y.\n\nSigned-off-by: a <b@c>", ["src/x.ts"]);
    expect(s).toContain("Because y.");
    expect(s).not.toContain("Signed-off-by");
    expect(s).toContain("`src/x.ts`");
  });
});

describe("stub miner", () => {
  it("stubs functions the tests call, hiding those tests", async () => {
    const tasks = await mineStubTasks(repo, { minBodyChars: 50 });
    expect(tasks.map((t) => t.meta["symbol"]).sort()).toEqual(["clamp", "slugify"]);
    const t = tasks.find((x) => x.meta["symbol"] === "slugify")!;
    const stubbed = t.overlay[0]!.content;
    expect(stubbed).toContain('throw new Error("not implemented: slugify")');
    expect(stubbed).toContain("Lower-case, trim"); // doc comment survives
    expect(stubbed).toContain("export function clamp(n, lo, hi) {\n  if (lo > hi)"); // other functions untouched
    expect(t.instruction).toContain("export function slugify(text)");
    const v = await verifyTask(t, { sourceRepo: repo });
    expect(v.verified).toMatchObject({ baseFails: true, referencePasses: true });
  });

  it("respects the minimum body size", async () => {
    expect(await mineStubTasks(repo, { minBodyChars: 10_000 })).toEqual([]);
  });
});

describe("splits", () => {
  it("is deterministic and keeps both sides non-empty", () => {
    const ts = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const s1 = splitTasks(ts);
    const s2 = splitTasks([...ts].reverse());
    expect(s1.heldOut.map((t) => t.id).sort()).toEqual(s2.heldOut.map((t) => t.id).sort());
    expect(s1.heldOut.length + s1.train.length).toBe(5);
    expect(splitTasks([{ id: "x" }, { id: "y" }]).heldOut).toHaveLength(1);
  });
});

afterAll(() => {
  // The miners and verifier must never modify the source repo.
  expect(gitIn(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
  expect(gitIn(repo, "status", "--porcelain").trim()).toBe("");
});

describe("test command templates", async () => {
  const { renderTestCommand } = await import("../src/tasks/git-miner.js");
  it("supports one-shot and per-file runners", () => {
    expect(renderTestCommand("npx vitest run {files}", ["a.ts", "b c.ts"])).toBe('npx vitest run a.ts "b c.ts"');
    expect(renderTestCommand("npx tsx {file}", ["a.ts", "b.ts"])).toBe("npx tsx a.ts && npx tsx b.ts");
  });
});

describe("deps: link", () => {
  it("junctions node_modules to a one-time cache copy, never to the source", async () => {
    const { mkdirSync, writeFileSync, lstatSync, realpathSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const r = makeFixtureRepo();
    mkdirSync(join(r, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(r, "node_modules", "dep", "index.js"), "export default 1;\n");
    const [t] = await mineGitTasks(r);
    const cache = mkdtempSync(join(tmpdir(), "autotune-cache-"));
    const ws = await sealWorkspace(t!, { sourceRepo: r, deps: { link: cache } });
    try {
      expect(lstatSync(join(ws.dir, "node_modules")).isSymbolicLink()).toBe(true);
      const real = realpathSync(join(ws.dir, "node_modules"));
      expect(real.startsWith(realpathSync(cache))).toBe(true);
      expect(readFileSync(join(ws.dir, "node_modules", "dep", "index.js"), "utf8")).toContain("export default 1");
    } finally {
      await ws.dispose();
    }
    // Disposing the workspace must not delete the shared cache.
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(cache);
    expect(entries).toHaveLength(1);
    expect(existsSync(join(cache, entries[0]!, "node_modules", "dep", "index.js"))).toBe(true);
    expect(existsSync(join(r, "node_modules", "dep", "index.js"))).toBe(true);
  });
});
