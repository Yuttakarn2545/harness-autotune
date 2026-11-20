# Harness Autotune

[![CI](https://github.com/Yuttakarn2545/harness-autotune/actions/workflows/ci.yml/badge.svg)](https://github.com/Yuttakarn2545/harness-autotune/actions/workflows/ci.yml)

**Change your `CLAUDE.md`, and get numbers that show whether it helped.**

Harness Autotune is a closed loop for your Claude Code setup (`CLAUDE.md`, skills). It mines friction from your own transcripts, proposes small config edits, benchmarks each edit against the unchanged baseline on **sealed tasks mined from your own repo**, and keeps only the edits that win on held-out tasks. A winning edit ships as a PR with a before/after table.

```
traces ──► friction report ──► candidate edits ──► sealed A/B bench ──► held-out verdict ──► PR
```

You can already find most of these pieces separately: posts on mining session logs, `/insights`, task-mining benches, observability dashboards. As far as I know, no tool joins them into one **verified** loop, where every config change has to pay for itself on tasks it was not tuned on.

---

## How it works

```mermaid
flowchart LR
  subgraph you["Your machine (read-only inputs)"]
    T["~/.claude/projects/*/*.jsonl<br/>Claude Code transcripts"]
    R["Target repo<br/>(git history + tests)"]
  end

  T --> MS["mine-sessions<br/>5 friction detectors<br/>cost per category"]
  MS --> FR[("friction.json / .md<br/>redacted")]
  FR --> P["propose<br/>Claude (schema-constrained)<br/>or offline rules"]
  P --> C[("candidates.json<br/>small CLAUDE.md / skill diffs")]

  R --> MT["mine-tasks<br/>git commits + stubbed functions"]
  MT --> V{"verify<br/>fails on base?<br/>passes on reference?"}
  V -->|yes| TS[("tasks/*.json<br/>train / held-out split")]

  C --> B["bench<br/>headless claude -p<br/>baseline vs candidate × N seeds"]
  TS --> B
  B --> S["seal workspace<br/>fresh repo, 1 orphan commit"]
  S --> A["agent run"] --> H["restore hidden tests<br/>score"]
  H --> RES[("results.jsonl")]
  RES --> REP["report<br/>Wilson + task bootstrap CIs<br/>accept / reject / inconclusive"]
  REP --> PR["apply --pr<br/>winning diff + table"]
```

| Stage | What it does | Key detail |
|---|---|---|
| `mine-sessions` | Parses Claude Code JSONL transcripts and finds **repeated failing commands, re-reads of unchanged files, user corrections (English + Thai), "done" without running tests, token-heavy turns** | Usage is counted once per `message.id`, because Claude Code writes one line per content block and repeats the usage on each. Paths, emails and secrets are redacted before anything is written. |
| `mine-tasks` | **git tasks**: commits that change both tests and source; base = parent, instruction = commit message, hidden tests = the commit's test files. **stub tasks** (SWE-smith style): a function the test suite calls gets its body replaced with `throw`; the agent re-implements it from its signature and call sites | Every task is checked: hidden tests must **fail on the sealed base and pass with the reference**, otherwise it is dropped. The source repo is opened read-only (`git archive` / `git show`). |
| Sealing | Each run gets a brand-new repo: snapshot + overlay, hidden tests removed, **one orphan commit** with a fixed author and date, no remotes, no packs | Agents read `git log` and reflogs to find the answer (cf. agentbench-local, Claw-SWE-Bench). An audit (`auditSeal`) checks this, and any run whose tool calls touch the source repo path is flagged **contaminated** and excluded. |
| `propose` | Claude turns the friction report and the current `CLAUDE.md` into ≤ N candidate edits, validated against a schema (append to `CLAUDE.md`, or create a new skill; nothing else) | `--via api` uses the Anthropic SDK (`claude-opus-5-5`, adaptive thinking, structured output, server-side refusal fallback). `--via claude-cli` uses `claude -p --json-schema` with your subscription. `--offline` uses rule templates. |
| `bench` | `claude -p --output-format stream-json` in each sealed workspace, with `--setting-sources project,local`, so the variant's files are the only difference between arms | Records pass, `total_cost_usd`, tokens, turns and wall time. Results go to resumable JSONL. Prints a **cost estimate and hard cap first**, and only runs with `--yes`. |
| `report` | Before/after table (Markdown + HTML) and a verdict per candidate on the **held-out** split | Wilson 95% CI for pass rates. 95% cluster bootstrap over tasks (seeds stay together) for the Δ pass rate and the cost-per-solved ratio. |

### Acceptance rule (held-out only)

- **accept** if the pass-rate gain is significant (CI lower bound > 0), *or* the pass rate held (point ≥ 0, CI lower bound ≥ −5 pp) **and** cost per solved task fell significantly (ratio CI upper bound < 1×).
- **reject** if the pass rate dropped significantly, or the edit costs more per solved task with no pass-rate gain.
- **inconclusive** otherwise, including whenever there are fewer than 5 paired held-out tasks. Small benchmarks mostly land here. That is the honest answer, not a bug.

---

## Quick start

Requires Node ≥ 22, git, and `tar` (built into Windows 10+, macOS and Linux). For live runs, also the [Claude Code](https://claude.com/claude-code) CLI.

```bash
git clone https://github.com/Yuttakarn2545/harness-autotune && cd harness-autotune
npm ci
npm run check   # build + typecheck + 45 offline tests, no API key needed
npm run demo    # full loop on a generated repo with a scripted agent (synthetic numbers)
```

Run it on your own setup:

```bash
# 1. friction in your transcripts (stays in .autotune/, which is git-ignored)
node dist/cli.js mine-sessions --project /path/to/your/repo        # or --all --since 30

# 2. sealed tasks from the repo's history and tests
node dist/cli.js mine-tasks --repo /path/to/your/repo --limit 10

# 3. candidate edits
node dist/cli.js propose --friction .autotune/friction/friction.json --repo /path/to/your/repo --via claude-cli
#    (--via api needs ANTHROPIC_API_KEY; --offline needs nothing)

# 4. cost estimate (dry run), then the real run
node dist/cli.js bench --repo /path/to/your/repo --tasks .autotune/tasks --candidates .autotune/candidates.json --seeds 2
node dist/cli.js bench ... --yes

# 5. table + HTML, then optionally a PR with the winning diff
node dist/cli.js report --results .autotune/results.jsonl --candidates .autotune/candidates.json --repo /path/to/your/repo
node dist/cli.js apply --repo /path/to/your/repo --candidates .autotune/candidates.json --id <winner> --report .autotune/report/report.md --pr
```

`--deps copy` (the default) copies `node_modules` into each workspace and re-points workspace links into the sealed copy, so tests run against the agent's code, and writes never reach your original repo. Use `--deps link` for large trees: one cached copy, junctioned into each workspace (katun’s 891 MB tree: ~25 s once, then instant). Use `--deps "setup:npm ci"` to install fresh instead. Test runners that take one file (`tsx script.ts`) use `--test-command "npx tsx {file}"`; `--tests <regex>` picks which test files count as hidden tests.

---

## Results

### Dogfood: friction mining on the author's own transcripts

`mine-sessions --all --since 60` over the author's real Claude Code history ran in seconds and found every category. The report itself stays private (it lives in git-ignored `.autotune/`). Only synthetic fixtures ship in this repo: [`examples/transcripts`](examples/transcripts).

<!-- friction:start -->
43 sessions · 541 human turns · 15,372 tool calls (last 60 days, all projects, measured 2026-11-20):

| Friction category | Findings | Occurrences | Sessions affected |
|---|---:|---:|---:|
| Same command failed repeatedly | 54 | 202 | 15 |
| Token-heavy turn (≥ 5× session median, ≥ $1) | 39 | 39 | 13 |
| User had to correct the agent | 16 | 16 | 8 |
| Claimed done without running tests | 11 | 11 | 6 |
| Same file re-read without changes | 7 | 27 | 4 |

Counts only; the per-finding evidence and costs stay local. The top failing command heads were shell mismatches on Windows (`cat`, `Get-Process`, `Set-Location`, `$var` in the wrong shell), which is exactly what a `CLAUDE.md` rule can target.
<!-- friction:end -->

### Dogfood: tasks mined from [thai-receipt-ai](https://github.com/Yuttakarn2545/thai-receipt-ai)

That repo has only 4 commits and none of them change tests, so the git miner finds nothing there. That is common for young repos, and it is why the stub miner exists. The stub miner produced **8 tasks, all verified** (hidden tests fail on the sealed base and pass with the reference): `parseThaiDate`, `formatThaiDate`, `validateTaxId`, `completeTaxId`, `promptPayQr`, `checkReceipt`, plus `scoreReceipt` and `similarity` from the eval scorer. Split: 4 train / 4 held-out.

### Live bench

<!-- bench:start -->
**Measured 2026-11-20.** `claude-opus-5-5` via `claude -p` (Claude Code 2.1.325), 8 stub tasks from thai-receipt-ai × 2 seeds × 2 arms = 32 runs, 5 held-out / 3 train, `--max-budget-usd 1` per run. Total API-equivalent cost **$8.00**; 0 runs contaminated, 0 infrastructure errors.

The candidate came from the **live proposer** (`propose --via claude-cli`, $0.07) reading the friction report above. It targets the "claimed done without running tests" category:

```diff
+## Verification before saying done
+- After your LAST code edit, and before you say done, fixed, committed or ✅, run `npm run typecheck` and `npx vitest run` (or `npx vitest run <path>` for a targeted check). If you touched packages/mcp, also run `npm run smoke`.
+- Quote the pass/fail summary line from that run in your final message.
+- If you edit anything after the run, run it again.
+- If you could not run verification (usage limit, missing env, build error), the first line of your reply must say `NOT VERIFIED` and give the reason. Do not use ✅ or "done" in that case.
+- Do not commit until the verification run passes, unless the user says to.
```

| Split | Variant | Runs | Pass rate (95% CI) | Cost / solved | Mean tokens | Mean turns | Mean wall |
|---|---|---:|---|---:|---:|---:|---:|
| train | baseline | 6 | 100% [61%, 100%] | $0.24 | 268,820 | 6.8 | 45s |
| train | verify-before-done | 6 | 100% [61%, 100%] | $0.26 | 310,842 | 8.0 | 66s |
| heldout | baseline | 10 | 100% [72%, 100%] | $0.21 | 201,996 | 5.7 | 37s |
| heldout | verify-before-done | 10 | 100% [72%, 100%] | $0.28 | 331,650 | 8.7 | 77s |

| Candidate | Paired held-out tasks | Δ pass rate (95% CI) | Cost-per-solved ratio (95% CI) | Verdict |
|---|---:|---|---|---|
| verify-before-done | 5 | +0 pp [+0, +0] | 1.35× [1.24×, 1.45×] | **reject**: more expensive per solved task with no pass-rate gain |

**Reading it:** the edit sounds obviously good, and it addresses real friction in the transcripts, but on these tasks it made Claude Code **35% more expensive per solved task and about 2× slower, for zero pass-rate gain**. The loop rejected it. This is the case the tool exists for. Caveats: the stub tasks are easy (both arms hit 100%, so a pass-rate gain could not show up here), and 5 held-out tasks is the minimum the rule allows. A harder task set is the next measurement, below.

#### Second run: harder tasks from [katun](https://github.com/Yuttakarn2545/katun) (Remotion video editor + MCP server)

**Measured 2026-11-20.** Same model and CLI. 12 stub tasks (DSP `biquad`, `readWav`, `layoutTimeline`, the app server's `startApp`, …), with hidden tests = the repo's own `tsx` test scripts (timeline, audio, components, live-bridge), all verified fail-on-base / pass-on-reference. Dependencies via `--deps link` (891 MB `node_modules`, cached once). 12 tasks × 2 seeds × 2 arms = 48 runs, 6 held-out. Total **$14.98** API-equivalent; 0 contaminated, 0 infrastructure errors.

Candidate: `win-shell-retry-rule`, the live proposer's answer to the top friction category (shell mismatches on Windows; "stop after 2 identical failures").

| Split | Variant | Runs | Pass rate (95% CI) | Cost / solved | Mean tokens | Mean turns | Mean wall |
|---|---|---:|---|---:|---:|---:|---:|
| train | baseline | 12 | 50% [25%, 75%] | $0.66 | 337,192 | 7.8 | 60s |
| train | win-shell-retry-rule | 12 | 50% [25%, 75%] | $0.70 | 390,450 | 9.2 | 66s |
| heldout | baseline | 12 | 83% [55%, 95%] | $0.35 | 300,540 | 6.8 | 62s |
| heldout | win-shell-retry-rule | 12 | 83% [55%, 95%] | $0.34 | 285,619 | 6.6 | 54s |

| Candidate | Paired held-out tasks | Δ pass rate (95% CI) | Cost-per-solved ratio (95% CI) | Verdict |
|---|---:|---|---|---|
| win-shell-retry-rule | 6 | +0 pp [+0, +0] | 0.97× [0.89×, 1.07×] | **inconclusive**: CIs too wide, add tasks or seeds |

**Reading it:** this set is no longer saturated: 4 of 12 tasks (`computeLayout`, `layoutTimeline`, `moveLineTo`, `startApp`) were **never** solved, in any of the 16 runs across both arms. But outcomes are bimodal per task: 8 tasks went 4/4, 4 went 0/4. A shell-hygiene rule doesn't change whether the model gets layout math right, and the cost difference (−3%) sits inside the noise, so the loop declines to call it. The honest result is "no measurable effect"; the edit stays out.

**What the two runs show together:** a plausible, transcript-grounded `CLAUDE.md` edit can be measurably harmful (run 1) or have no measurable effect (run 2). Without the A/B you would ship both.
<!-- bench:end -->

### Offline demo (scripted agent, not a model)

`npm run demo` runs the whole loop with a scripted agent that applies the reference solution with a fixed probability: 40% for baseline, 90% when the candidate text is present. Use it to check the plumbing and the statistics. It tells you nothing about Claude.

---

## Design notes

- **Why stub tasks?** Real benchmarks need many tasks, and most personal repos don't have hundreds of test-changing commits. Stubbing functions the test suite exercises gives tasks that are solvable by construction and still verified by execution. They are easier than real feature work, so treat absolute pass rates as an upper bound. The **difference** between arms is what matters.
- **Why held-out?** Proposals are derived from your transcripts and may be iterated on the train split. Acceptance only looks at tasks the proposal never saw, the same discipline as the train/validation/test split in prompt hill-climbing.
- **Why cluster bootstrap?** Seeds of the same task are correlated. Resampling tasks, not runs, keeps a lucky task from looking like a real effect.
- **Costs.** Transcript costs are API list-price equivalents computed from each response's usage block. Bench costs are Claude Code's `total_cost_usd`. On a subscription, `claude -p` uses your plan's usage instead of money.
- **Safety.** Proposals can only append to `CLAUDE.md` or create `.claude/skills/<name>/SKILL.md`. Anything else is rejected before it runs. `apply` refuses to run on a dirty working tree and works on a new branch.

## Layout

```
src/sessions   transcript parser, friction detectors, redaction, report
src/tasks      git + stub miners, sealing, verification, splits
src/propose    candidate schema/validation, rule proposer, Claude proposer (API or claude -p)
src/bench      Claude Code agent (stream-json), scripted agent, runner, statistics
src/report     Markdown + HTML report
test/          offline tests: synthetic transcripts and generated fixture repos
```

## License

MIT
