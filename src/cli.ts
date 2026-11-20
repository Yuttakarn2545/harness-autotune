#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { git, run } from "./exec.js";
import { listTranscripts, mineSessions, frictionMarkdown, projectDirFor, type FrictionReport } from "./sessions/report.js";
import { mineGitTasks, showFile, detectTestCommand } from "./tasks/git-miner.js";
import { mineStubTasks } from "./tasks/stub-miner.js";
import { isUsable, loadTasks, saveTasks, splitTasks, verifyTask } from "./tasks/verify.js";
import type { DepsMode } from "./tasks/seal.js";
import type { Task } from "./tasks/types.js";
import { ruleProposals } from "./propose/rules.js";
import { proposeWithClaude, proposeViaClaudeCli, DEFAULT_PROPOSER_MODEL } from "./propose/llm.js";
import { applyCandidate, renderDiff, validateCandidate, type Candidate } from "./propose/types.js";
import { BASELINE, estimateCost, loadRecords, planBench, runBench, type Variant } from "./bench/runner.js";
import { ClaudeCodeAgent, type Agent } from "./bench/agent.js";
import { ScriptedAgent } from "./bench/scripted.js";
import { benchHtml, benchMarkdown, buildBenchReport } from "./report/report.js";

const HELP = `harness-autotune — prove CLAUDE.md / skill changes on tasks mined from your own repo

Usage: harness-autotune <command> [options]

  mine-sessions   Detect friction in Claude Code transcripts (~/.claude/projects/<project>)
      --project <cwd>        project directory whose transcripts to read (default: current dir)
      --dir <path>           read transcripts from this directory instead
      --all                  every project under ~/.claude/projects
      --since <days>         only transcripts modified in the last N days
      --limit <n>            newest N transcripts
      --out <dir>            default .autotune/friction

  mine-tasks      Build a sealed benchmark from a repo (read-only: uses git archive/show only)
      --repo <path>          target repository (required)
      --kind stub|git|both   default both
      --limit <n>            max tasks per kind (default 8)
      --scope <prefix>       only files under this path, e.g. packages/core
      --test-command <cmd>   template; {files} = hidden test paths (default: detected)
      --deps copy|none|setup:<cmd>   how workspaces get dependencies (default copy)
      --no-verify            skip fail-on-base / pass-on-reference check
      --out <dir>            default .autotune/tasks

  propose         Turn a friction report into candidate CLAUDE.md / skill edits
      --friction <file>      friction.json from mine-sessions (required)
      --repo <path>          target repo (reads its CLAUDE.md)
      --offline              rule-based templates, no API call
      --via api|claude-cli    api = Anthropic SDK (ANTHROPIC_API_KEY); claude-cli = headless claude -p (subscription)
      --model <id>           default ${DEFAULT_PROPOSER_MODEL}
      --max <n>              default 3
      --out <file>           default .autotune/candidates.json

  bench           Run baseline vs candidates on the tasks with headless Claude Code
      --repo <path> --tasks <dir> --candidates <file>   (required)
      --only <id,id>         candidate ids to include
      --seeds <n>            default 2
      --held-out <frac>      default 0.5
      --model <id>           passed to claude --model
      --max-turns <n>        default 40
      --max-budget-usd <x>   per-run cap passed to claude (default 1.5)
      --timeout-min <n>      per-run wall clock (default 20)
      --assume-run-usd <x>   per-run cost assumption for the estimate (default 0.6)
      --agent claude|scripted   scripted = offline pipeline check, synthetic numbers
      --deps …               as for mine-tasks
      --results <file>       default .autotune/results.jsonl (resumable)
      --yes                  actually run; without it only the cost estimate is printed

  report          Before/after table (markdown + HTML) from bench results
      --results <file> --candidates <file> --repo <path>
      --label <text>  --out <dir> (default .autotune/report)

  apply           Write a winning candidate into the repo on a new branch (optionally open a PR)
      --repo <path> --candidates <file> --id <candidate>  [--report <md>] [--pr]
`;

function parseDeps(v: string | undefined): DepsMode {
  if (!v || v === "copy") return "copy";
  if (v === "none") return "none";
  if (v.startsWith("setup:")) return { setup: v.slice(6) };
  throw new Error(`bad --deps ${v}`);
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

async function writeOut(path: string, content: string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content);
  console.log(`wrote ${path}`);
}

function req(v: string | undefined, name: string): string {
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

async function cmdMineSessions(args: string[]) {
  const { values } = parseArgs({ args, options: { project: { type: "string" }, dir: { type: "string" }, all: { type: "boolean" }, since: { type: "string" }, limit: { type: "string" }, out: { type: "string" } } });
  const listOpts = { sinceDays: values.since ? Number(values.since) : undefined, limit: values.limit ? Number(values.limit) : undefined };
  let dirs: string[];
  if (values.all) {
    const root = join(homedir(), ".claude", "projects");
    dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } else {
    dirs = [values.dir ?? projectDirFor(resolve(values.project ?? process.cwd()))];
    if (!existsSync(dirs[0]!)) throw new Error(`no transcripts at ${dirs[0]}`);
  }
  const files: string[] = [];
  for (const d of dirs) files.push(...(await listTranscripts(d, listOpts)));
  console.error(`reading ${files.length} transcripts from ${dirs.length} project folder(s)`);
  const report = await mineSessions(files, undefined, values.all ? "all projects" : dirs[0]!);
  const out = values.out ?? ".autotune/friction";
  await writeOut(join(out, "friction.json"), JSON.stringify(report, null, 2));
  await writeOut(join(out, "friction.md"), frictionMarkdown(report));
  for (const c of report.categories) console.log(`${c.label.padEnd(38)} ${String(c.findings).padStart(4)} findings  $${c.usd.toFixed(2)}`);
}

async function cmdMineTasks(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { repo: { type: "string" }, kind: { type: "string" }, limit: { type: "string" }, scope: { type: "string" }, "test-command": { type: "string" }, deps: { type: "string" }, "no-verify": { type: "boolean" }, out: { type: "string" } },
  });
  const repo = resolve(req(values.repo, "repo"));
  const kind = values.kind ?? "both";
  const limit = Number(values.limit ?? 8);
  const common = { limit, scope: values.scope, testCommand: values["test-command"] };
  let tasks: Task[] = [];
  if (kind === "git" || kind === "both") tasks.push(...(await mineGitTasks(repo, common)));
  if (kind === "stub" || kind === "both") tasks.push(...(await mineStubTasks(repo, common)));
  console.error(`mined ${tasks.length} candidate tasks`);
  if (!values["no-verify"]) {
    const deps = parseDeps(values.deps);
    const verified: Task[] = [];
    for (const t of tasks) {
      const v = await verifyTask(t, { sourceRepo: repo, deps });
      const usable = isUsable(v);
      console.error(`  ${usable ? "ok  " : "drop"} ${t.id}  base fails=${v.verified?.baseFails} reference passes=${v.verified?.referencePasses}`);
      if (usable) verified.push(v);
    }
    tasks = verified;
  }
  const out = values.out ?? ".autotune/tasks";
  await saveTasks(out, tasks);
  const { train, heldOut } = splitTasks(tasks);
  console.log(`${tasks.length} tasks → ${out} (train ${train.length}, held-out ${heldOut.length})`);
}

async function repoFacts(repo: string): Promise<string> {
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const facts: string[] = [];
  const pkg = await showFile(repo, head, "package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { scripts?: Record<string, string> };
      facts.push(`package.json scripts: ${Object.entries(j.scripts ?? {}).map(([k, v]) => `${k}=\`${v}\``).join("; ")}`);
    } catch {
      /* ignore */
    }
  }
  const tc = await detectTestCommand(repo, head);
  if (tc) facts.push(`test runner: ${tc.replace(" {files}", "")}`);
  facts.push(`platform: ${process.platform}`);
  return facts.join("\n");
}

async function cmdPropose(args: string[]) {
  const { values } = parseArgs({ args, options: { friction: { type: "string" }, repo: { type: "string" }, offline: { type: "boolean" }, via: { type: "string" }, model: { type: "string" }, max: { type: "string" }, out: { type: "string" } } });
  const report = await readJson<FrictionReport>(req(values.friction, "friction"));
  const repo = values.repo ? resolve(values.repo) : undefined;
  const max = Number(values.max ?? 3);
  let candidates: Candidate[];
  if (values.offline) {
    const tc = repo ? await detectTestCommand(repo, "HEAD") : undefined;
    candidates = ruleProposals(report, tc?.replace(" {files}", "")).slice(0, max);
  } else {
    const claudeMd = repo ? ((await showFile(repo, "HEAD", "CLAUDE.md")) ?? "") : "";
    const input = { report, currentClaudeMd: claudeMd, repoFacts: repo ? await repoFacts(repo) : "", max };
    const via = values.via ?? "api";
    if (via !== "api" && via !== "claude-cli") throw new Error(`bad --via ${via}`);
    const res = via === "api" ? await proposeWithClaude(input, { model: values.model }) : await proposeViaClaudeCli(input, { model: values.model });
    if ("costUsd" in res && typeof res.costUsd === "number") console.error(`proposer cost: $${res.costUsd.toFixed(3)} (API-equivalent)`);
    for (const r of res.rejected) console.error(`rejected ${r.candidate.id}: ${r.problems.join("; ")}`);
    console.error(`proposer: ${res.model}, ${res.usage?.input_tokens} in / ${res.usage?.output_tokens} out tokens`);
    candidates = res.candidates;
  }
  const out = values.out ?? ".autotune/candidates.json";
  await writeOut(out, JSON.stringify(candidates, null, 2));
  for (const c of candidates) console.log(`- ${c.id}: ${c.title}`);
}

async function loadCandidates(file: string, only?: string): Promise<Candidate[]> {
  const all = await readJson<Candidate[]>(file);
  const ids = only?.split(",").map((s) => s.trim());
  const picked = ids ? all.filter((c) => ids.includes(c.id)) : all;
  for (const c of picked) {
    const p = validateCandidate(c);
    if (p.length) throw new Error(`candidate ${c.id} invalid: ${p.join("; ")}`);
  }
  return picked;
}

async function cmdBench(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" }, tasks: { type: "string" }, candidates: { type: "string" }, only: { type: "string" }, seeds: { type: "string" },
      "held-out": { type: "string" }, model: { type: "string" }, "max-turns": { type: "string" }, "max-budget-usd": { type: "string" },
      "timeout-min": { type: "string" }, "assume-run-usd": { type: "string" }, agent: { type: "string" }, deps: { type: "string" },
      results: { type: "string" }, yes: { type: "boolean" },
    },
  });
  const repo = resolve(req(values.repo, "repo"));
  const tasks = await loadTasks(req(values.tasks, "tasks"));
  if (!tasks.length) throw new Error("no tasks");
  const candidates = await loadCandidates(req(values.candidates, "candidates"), values.only);
  const variants: Variant[] = [BASELINE, ...candidates.map((c) => ({ id: c.id, candidate: c }))];
  const seeds = Number(values.seeds ?? 2);
  const maxBudget = Number(values["max-budget-usd"] ?? 1.5);
  const agentKind = values.agent ?? "claude";
  const results = values.results ?? (agentKind === "scripted" ? ".autotune/results-scripted.jsonl" : ".autotune/results.jsonl");
  const plan = planBench(tasks, variants, seeds, Number(values["held-out"] ?? 0.5));
  const existing = await loadRecords(results);
  const est = estimateCost(plan, existing, maxBudget, Number(values["assume-run-usd"] ?? 0.6));
  console.log(`plan: ${variants.length} variants × ${tasks.length} tasks × ${seeds} seeds = ${est.runs} runs (${est.pending} pending)`);
  console.log(`held-out: ${plan.heldOut.join(", ")}`);
  if (agentKind === "claude") {
    console.log(`estimated cost: ~$${est.expectedUsd.toFixed(2)} (${est.perRunSource}: $${est.perRunUsd.toFixed(2)}/run); hard cap $${est.worstCaseUsd.toFixed(2)} (--max-budget-usd ${maxBudget} × ${est.pending})`);
    console.log(`costs are API list-price equivalents; on a Claude subscription, \`claude -p\` uses your plan's usage instead.`);
  }
  if (!values.yes) {
    console.log(`dry run — re-run with --yes to execute.`);
    process.exitCode = 3;
    return;
  }
  const agent: Agent = agentKind === "scripted" ? new ScriptedAgent(0.6) : new ClaudeCodeAgent();
  await runBench(plan, agent, {
    sourceRepo: repo,
    seeds,
    heldOutFraction: Number(values["held-out"] ?? 0.5),
    deps: parseDeps(values.deps),
    resultsFile: results,
    model: values.model,
    maxTurns: Number(values["max-turns"] ?? 40),
    maxBudgetUsd: maxBudget,
    timeoutMs: Number(values["timeout-min"] ?? 20) * 60_000,
    log: (m) => console.log(m),
  });
  console.log(`results → ${results}`);
}

async function currentConfig(repo: string, c: Candidate): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of c.edits) {
    const v = await showFile(repo, "HEAD", e.file);
    if (v !== undefined) m.set(e.file, v);
  }
  return m;
}

async function cmdReport(args: string[]) {
  const { values } = parseArgs({ args, options: { results: { type: "string" }, candidates: { type: "string" }, repo: { type: "string" }, label: { type: "string" }, out: { type: "string" } } });
  const records = await loadRecords(values.results ?? ".autotune/results.jsonl");
  if (!records.length) throw new Error("no results");
  const candidates = values.candidates ? await readJson<Candidate[]>(values.candidates) : [];
  const diffs: Record<string, string> = {};
  if (values.repo) for (const c of candidates) diffs[c.id] = renderDiff(await currentConfig(resolve(values.repo), c), c);
  const r = buildBenchReport(records, candidates, diffs, values.label ?? "bench");
  const out = values.out ?? ".autotune/report";
  await writeOut(join(out, "report.json"), JSON.stringify(r, null, 2));
  await writeOut(join(out, "report.md"), benchMarkdown(r));
  await writeOut(join(out, "report.html"), benchHtml(r));
  for (const c of r.comparisons) console.log(`${c.candidate}: ${c.verdict} — ${c.reason}`);
}

async function cmdApply(args: string[]) {
  const { values } = parseArgs({ args, options: { repo: { type: "string" }, candidates: { type: "string" }, id: { type: "string" }, report: { type: "string" }, pr: { type: "boolean" } } });
  const repo = resolve(req(values.repo, "repo"));
  const [c] = await loadCandidates(req(values.candidates, "candidates"), req(values.id, "id"));
  if (!c) throw new Error(`no candidate ${values.id}`);
  if ((await git(repo, ["status", "--porcelain"])).trim()) throw new Error("target repo has uncommitted changes; refusing to apply");
  const branch = `autotune/${c.id}`;
  await git(repo, ["switch", "-c", branch]);
  const files = applyCandidate(await currentConfig(repo, c), c);
  for (const f of files) await writeOut(join(repo, ...f.path.split("/")), f.content);
  await git(repo, ["add", ...files.map((f) => f.path)]);
  await git(repo, ["commit", "-m", `harness: ${c.title}\n\n${c.rationale}`]);
  console.log(`committed on ${branch}`);
  if (values.pr) {
    const body = `${c.rationale}\n\n${values.report ? await readFile(values.report, "utf8") : ""}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    await git(repo, ["push", "-u", "origin", branch]);
    const r = await run("gh", ["pr", "create", "--title", `harness: ${c.title}`, "--body", body], { cwd: repo });
    console.log(r.stdout || r.stderr);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const table: Record<string, (a: string[]) => Promise<void>> = {
    "mine-sessions": cmdMineSessions,
    "mine-tasks": cmdMineTasks,
    propose: cmdPropose,
    bench: cmdBench,
    report: cmdReport,
    apply: cmdApply,
  };
  if (!cmd || cmd === "--help" || cmd === "-h" || !table[cmd]) {
    process.stdout.write(HELP);
    if (cmd && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
    return;
  }
  await table[cmd]!(rest);
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
