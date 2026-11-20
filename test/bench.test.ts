import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compare, summarizeArm, wilson, bootstrapByTask, type RunRecord } from "../src/bench/stats.js";
import { isContaminated, parseStreamJson } from "../src/bench/agent.js";
import { ScriptedAgent } from "../src/bench/scripted.js";
import { BASELINE, estimateCost, loadRecords, planBench, runBench } from "../src/bench/runner.js";
import { mineStubTasks } from "../src/tasks/stub-miner.js";
import { mineGitTasks } from "../src/tasks/git-miner.js";
import type { Candidate } from "../src/propose/types.js";
import { benchHtml, benchMarkdown, buildBenchReport } from "../src/report/report.js";
import { makeFixtureRepo } from "./helpers.js";

describe("stats", () => {
  it("wilson interval matches the textbook value", () => {
    const w = wilson(8, 10);
    expect(w.point).toBe(0.8);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0).lo).toBe(0);
  });
  it("bootstrap is reproducible", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const mean = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length;
    expect(bootstrapByTask(xs, mean)).toEqual(bootstrapByTask(xs, mean));
    const ci = bootstrapByTask(xs, mean);
    expect(ci.lo).toBeLessThan(4.5);
    expect(ci.hi).toBeGreaterThan(4.5);
  });

  const rec = (variant: string, task: string, seed: number, pass: boolean, costUsd: number): RunRecord => ({
    variant, task, seed, split: "heldout", pass, costUsd, tokens: 1, turns: 1, wallMs: 1, contaminated: false,
  });

  it("accepts a clear pass-rate win", () => {
    const rs: RunRecord[] = [];
    for (let t = 0; t < 12; t++) for (let s = 0; s < 2; s++) {
      rs.push(rec("baseline", `t${t}`, s, t % 3 === 0, 1));
      rs.push(rec("cand", `t${t}`, s, true, 1));
    }
    const c = compare(rs, "baseline", "cand");
    expect(c.verdict).toBe("accept");
    expect(c.passDelta.lo).toBeGreaterThan(0);
  });
  it("accepts equal pass rate at clearly lower cost", () => {
    const rs: RunRecord[] = [];
    for (let t = 0; t < 10; t++) {
      rs.push(rec("baseline", `t${t}`, 0, true, 1 + t * 0.1));
      rs.push(rec("cand", `t${t}`, 0, true, 0.5 + t * 0.05));
    }
    const c = compare(rs, "baseline", "cand");
    expect(c.verdict).toBe("accept");
    expect(c.costRatio.hi).toBeLessThan(1);
  });
  it("rejects a clear regression and is inconclusive on noise", () => {
    const worse: RunRecord[] = [];
    const noisy: RunRecord[] = [];
    for (let t = 0; t < 10; t++) {
      worse.push(rec("baseline", `t${t}`, 0, true, 1), rec("cand", `t${t}`, 0, t < 2, 1));
      noisy.push(rec("baseline", `t${t}`, 0, t % 2 === 0, 1), rec("cand", `t${t}`, 0, t % 2 === 1, 1));
    }
    expect(compare(worse, "baseline", "cand").verdict).toBe("reject");
    expect(compare(noisy, "baseline", "cand").verdict).toBe("inconclusive");
  });
  it("never decides on fewer than 5 paired held-out tasks", () => {
    const rs: RunRecord[] = [];
    for (let t = 0; t < 4; t++) for (let s = 0; s < 5; s++) rs.push(rec("baseline", `t${t}`, s, false, 1), rec("cand", `t${t}`, s, true, 1));
    const c = compare(rs, "baseline", "cand");
    expect(c.verdict).toBe("inconclusive");
    expect(c.reason).toMatch(/need ≥ 5/);
  });
  it("excludes contaminated runs", () => {
    const rs = [rec("baseline", "a", 0, true, 1), { ...rec("baseline", "b", 0, true, 1), contaminated: true }];
    const a = summarizeArm(rs, "baseline", "heldout");
    expect(a.runs).toBe(1);
    expect(a.excluded).toBe(1);
  });
});

describe("claude stream-json", () => {
  it("parses the result event and tool calls", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Read", input: { file_path: "C:\\Dev\\src-repo\\a.ts" } }], usage: { input_tokens: 5, output_tokens: 5 } } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 4, total_cost_usd: 0.42, result: "done", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } }),
    ].join("\n");
    const r = parseStreamJson(stream);
    expect(r).toMatchObject({ ok: true, costUsd: 0.42, costSource: "reported", turns: 4, resultText: "done" });
    expect(r.tokens).toEqual({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 10 });
    expect(isContaminated(r.toolInputs, "C:\\Dev\\src-repo")).toBe(true);
    expect(isContaminated(['Bash:{"command":"cat /c/dev/src-repo/x"}'], "C:\\Dev\\src-repo")).toBe(true);
    expect(isContaminated(r.toolInputs, "C:\\Dev\\other")).toBe(false);
  });
  it("classifies API errors before any work as infra, not as a task failure", () => {
    const ev = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 400, num_turns: 1, total_cost_usd: 0, result: "API Error: 400 unsupported model" });
    expect(parseStreamJson(ev).error).toMatch(/^infra: API Error/);
    const work = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 30, total_cost_usd: 0.9 });
    expect(parseStreamJson(work).error).toBe("claude result: error_max_turns");
  });
  it("reports a missing result event as an error", () => {
    expect(parseStreamJson("garbage").error).toMatch(/no result/);
  });
});

describe("bench pipeline (offline, scripted agent)", () => {
  it("runs baseline vs candidate end to end, resumes, and reports", async () => {
    const repo = makeFixtureRepo();
    const tasks = [...(await mineGitTasks(repo)), ...(await mineStubTasks(repo, { minBodyChars: 50 }))];
    expect(tasks).toHaveLength(3);
    const cand: Candidate = {
      id: "magic-hint",
      title: "test candidate",
      rationale: "r",
      targets: ["unverified-done"],
      edits: [{ file: "CLAUDE.md", mode: "append", content: "MAGIC" }],
    };
    // The scripted agent solves every task when it sees the candidate's text, otherwise none.
    const agent = new ScriptedAgent((_t, ws) => (readFileSync(join(ws, "CLAUDE.md"), "utf8").includes("MAGIC") ? 1 : 0));
    const plan = planBench(tasks, [BASELINE, { id: cand.id, candidate: cand }], 2, 0.5);
    expect(plan.runs).toHaveLength(12);
    const out = join(mkdtempSync(join(tmpdir(), "autotune-res-")), "results.jsonl");
    const est = estimateCost(plan, [], 2, 0.5);
    expect(est).toMatchObject({ pending: 12, expectedUsd: 6, worstCaseUsd: 24 });

    const opts = { sourceRepo: repo, seeds: 2, heldOutFraction: 0.5, deps: "none" as const, resultsFile: out, maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 60_000 };
    const records = await runBench(plan, agent, opts);
    expect(records).toHaveLength(12);
    expect(records.filter((r) => r.variant === "baseline").every((r) => !r.pass)).toBe(true);
    expect(records.filter((r) => r.variant === "magic-hint").every((r) => r.pass)).toBe(true);

    // Resume: nothing left to do.
    const again = await runBench(plan, agent, opts);
    expect(again).toHaveLength(12);
    expect((await loadRecords(out)).length).toBe(12);
    expect(estimateCost(plan, again, 2, 0.5).pending).toBe(0);

    const report = buildBenchReport(records, [cand], { "magic-hint": "+MAGIC" }, "fixture");
    const md = benchMarkdown(report);
    expect(md).toContain("| heldout | magic-hint |");
    expect(md).toContain("Held-out decision");
    expect(benchHtml(report)).toContain("<svg");
    expect(existsSync(out)).toBe(true);
  });
});

describe("resume", () => {
  it("retries infra failures and keeps the latest record per run", async () => {
    const { writeFileSync } = await import("node:fs");
    const repo = makeFixtureRepo();
    const tasks = await mineStubTasks(repo, { minBodyChars: 50 });
    const plan = planBench(tasks, [BASELINE], 1, 0.5);
    const out = join(mkdtempSync(join(tmpdir(), "autotune-resume-")), "r.jsonl");
    const infra = { variant: "baseline", task: tasks[0]!.id, seed: 0, split: "heldout", pass: false, costUsd: 0, tokens: 0, turns: 1, wallMs: 1, contaminated: false, error: "infra: API Error: 429 usage limit" };
    writeFileSync(out, JSON.stringify(infra) + "\n");
    const records = await runBench(plan, new ScriptedAgent(1), { sourceRepo: repo, seeds: 1, heldOutFraction: 0.5, deps: "none", resultsFile: out, maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 60_000 });
    expect(records).toHaveLength(tasks.length);
    expect(records.every((r) => r.pass && !r.error)).toBe(true);
    const loaded = await loadRecords(out);
    expect(loaded).toHaveLength(tasks.length);
    expect(loaded.find((r) => r.task === tasks[0]!.id)!.pass).toBe(true);
  });
});

describe("diagnostics", () => {
  it("records the hidden-test tail for failed runs only", async () => {
    const repo = makeFixtureRepo();
    const tasks = await mineStubTasks(repo, { minBodyChars: 50 });
    const out = join(mkdtempSync(join(tmpdir(), "autotune-tail-")), "r.jsonl");
    const records = await runBench(planBench(tasks, [BASELINE], 1, 0.5), new ScriptedAgent(0), { sourceRepo: repo, seeds: 1, heldOutFraction: 0.5, deps: "none", resultsFile: out, maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 60_000 });
    expect(records.every((r) => !r.pass && (r.testTail ?? "").includes("not implemented"))).toBe(true);
  });
});
