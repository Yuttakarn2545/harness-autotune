import type { Task } from "../tasks/types.js";
import { run } from "../exec.js";
import { emptyTotals, usageCost, type TokenTotals, type Usage } from "../pricing.js";

export interface AgentRun {
  ok: boolean;
  costUsd: number;
  /** "reported" = from Claude Code's own result event; "computed" = from usage × list price. */
  costSource: "reported" | "computed" | "none";
  tokens: TokenTotals;
  turns: number;
  wallMs: number;
  resultText: string;
  /** Serialized tool inputs, used to detect a run that peeked outside its sealed workspace. */
  toolInputs: string[];
  error?: string;
}

export interface AgentOptions {
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

export interface Agent {
  name: string;
  /**  is passed for scripted test agents only; real agents must use just the instruction. */
  run(workspace: string, instruction: string, opts: AgentOptions, task?: Task): Promise<AgentRun>;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: Usage;
  modelUsage?: Record<string, unknown>;
  message?: { model?: string; content?: { type?: string; name?: string; input?: unknown }[]; usage?: Usage; id?: string };
}

/** Parse `claude -p --output-format stream-json --verbose` output. Exported for offline tests. */
export function parseStreamJson(stdout: string): Omit<AgentRun, "wallMs"> {
  const toolInputs: string[] = [];
  let result: StreamEvent | undefined;
  let tokens = emptyTotals();
  let computed = 0;
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "assistant" && ev.message) {
      for (const b of ev.message.content ?? []) if (b.type === "tool_use") toolInputs.push(`${b.name}:${JSON.stringify(b.input)}`);
      const id = ev.message.id;
      if (ev.message.usage && (!id || !seen.has(id))) {
        if (id) seen.add(id);
        const c = usageCost(ev.message.usage, ev.message.model);
        computed += c.usd;
        tokens = {
          input: tokens.input + c.tokens.input,
          output: tokens.output + c.tokens.output,
          cacheRead: tokens.cacheRead + c.tokens.cacheRead,
          cacheWrite: tokens.cacheWrite + c.tokens.cacheWrite,
        };
      }
    }
    if (ev.type === "result") result = ev;
  }
  if (result?.usage) {
    const u = result.usage;
    tokens = {
      input: u.input_tokens ?? tokens.input,
      output: u.output_tokens ?? tokens.output,
      cacheRead: u.cache_read_input_tokens ?? tokens.cacheRead,
      cacheWrite: u.cache_creation_input_tokens ?? tokens.cacheWrite,
    };
  }
  const reported = typeof result?.total_cost_usd === "number";
  return {
    ok: !!result && !result.is_error,
    costUsd: reported ? result!.total_cost_usd! : computed,
    costSource: reported ? "reported" : computed ? "computed" : "none",
    tokens,
    turns: result?.num_turns ?? 0,
    resultText: result?.result ?? "",
    toolInputs,
    error: result ? (result.is_error ? `claude result: ${result.subtype ?? "error"}` : undefined) : "no result event in stream",
  };
}

/**
 * Headless Claude Code. Runs with the workspace as cwd and only project/local settings, so the
 * variant's CLAUDE.md and skills are what differ between arms. Uses whatever auth `claude` has
 * (subscription login or ANTHROPIC_API_KEY); `--max-budget-usd` caps each run.
 */
export class ClaudeCodeAgent implements Agent {
  name = "claude-code";
  constructor(private bin = process.env["AUTOTUNE_CLAUDE_BIN"] ?? "claude") {}

  async run(workspace: string, instruction: string, opts: AgentOptions): Promise<AgentRun> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--setting-sources",
      "project,local",
      "--max-turns",
      String(opts.maxTurns),
      "--max-budget-usd",
      String(opts.maxBudgetUsd),
    ];
    if (opts.model) args.push("--model", opts.model);
    const r = await run(this.bin, args, { cwd: workspace, input: instruction, timeoutMs: opts.timeoutMs, maxOutput: 50_000_000 });
    const parsed = parseStreamJson(r.stdout);
    return {
      ...parsed,
      wallMs: r.ms,
      error: r.timedOut ? "timeout" : parsed.error ?? (r.code !== 0 ? `exit ${r.code}: ${r.stderr.slice(-300)}` : undefined),
    };
  }
}

/** Does any tool call reference the original repo path, i.e. the agent escaped its sealed copy? */
export function isContaminated(toolInputs: string[], sourceRepo: string): boolean {
  const norm = (s: string) => s.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
  const needle = norm(sourceRepo).replace(/\/$/, "");
  const posix = needle.replace(/^([a-z]):/, "/$1");
  return toolInputs.some((t) => {
    const n = norm(t);
    return n.includes(needle) || n.includes(posix);
  });
}
