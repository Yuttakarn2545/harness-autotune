import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { frictionMarkdown, type FrictionReport } from "../sessions/report.js";
import { ProposalSetSchema, validateCandidate, type Candidate } from "./types.js";

export const DEFAULT_PROPOSER_MODEL = "claude-opus-5-5";

export const PROPOSER_SYSTEM = `You tune a developer's Claude Code harness: the CLAUDE.md file and project skills (.claude/skills/<name>/SKILL.md).
You are given a friction report mined from their real Claude Code transcripts, plus the repo's current CLAUDE.md.

Propose candidate edits. Each candidate is one small, testable change aimed at a specific friction category:
- Edits may only append to CLAUDE.md or create a new skill file. Never edit code or settings.
- Keep each candidate under ~1200 characters. Smaller edits are easier to attribute.
- Every instruction must be concrete and checkable in a transcript (a command to run, a thing to avoid), not a virtue ("be careful").
- Do not restate what the current CLAUDE.md already says.
- Ground the rationale in the numbers in the report. Do not invent incidents.
- Each candidate will be benchmarked against the unchanged baseline on held-out tasks and kept only if it wins, so prefer edits whose effect would show up in pass rate, turns or cost.
- ids are short kebab-case.`;

export interface ProposeInput {
  report: FrictionReport;
  currentClaudeMd: string;
  repoFacts: string;
  max: number;
}

export function buildProposerPrompt(input: ProposeInput): string {
  return [
    `## Friction report\n\n${frictionMarkdown(input.report)}`,
    `## Current CLAUDE.md\n\n${input.currentClaudeMd.trim() ? "```markdown\n" + input.currentClaudeMd.trim() + "\n```" : "(none)"}`,
    `## Repo facts\n\n${input.repoFacts}`,
    `Propose at most ${input.max} candidates, highest expected impact first.`,
  ].join("\n\n");
}

export interface ProposeResult {
  candidates: Candidate[];
  rejected: { candidate: Candidate; problems: string[] }[];
  usage?: { input_tokens: number; output_tokens: number };
  model: string;
}

/**
 * Ask Claude for candidate edits, with schema-constrained output. Server-side refusal fallbacks are on
 * (`fallbacks: "default"`), so a policy decline is re-run on a fallback model instead of failing the step.
 */
export async function proposeWithClaude(input: ProposeInput, opts: { client?: Anthropic; model?: string } = {}): Promise<ProposeResult> {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? DEFAULT_PROPOSER_MODEL;
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(ProposalSetSchema) },
    system: PROPOSER_SYSTEM,
    messages: [{ role: "user", content: buildProposerPrompt(input) }],
  });
  if (response.stop_reason === "refusal") throw new Error("proposer request was declined (refusal)");
  if (response.stop_reason === "max_tokens") throw new Error("proposer hit max_tokens before finishing");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("proposer returned no parseable output");
  const candidates: Candidate[] = [];
  const rejected: ProposeResult["rejected"] = [];
  for (const c of parsed.candidates.slice(0, input.max)) {
    const problems = validateCandidate(c);
    if (problems.length) rejected.push({ candidate: c, problems });
    else candidates.push(c);
  }
  return {
    candidates,
    rejected,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    model: response.model,
  };
}

function splitValid(list: Candidate[], max: number) {
  const candidates: Candidate[] = [];
  const rejected: ProposeResult["rejected"] = [];
  for (const c of list.slice(0, max)) {
    const problems = validateCandidate(c);
    if (problems.length) rejected.push({ candidate: c, problems });
    else candidates.push(c);
  }
  return { candidates, rejected };
}

/** Parse `claude -p --output-format json --json-schema …` output into candidates. Exported for tests. */
export function parseCliProposal(stdout: string, max: number): ProposeResult & { costUsd?: number } {
  const ev = JSON.parse(stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop() ?? "{}") as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number };
    modelUsage?: Record<string, unknown>;
  };
  if (ev.is_error) throw new Error(`claude -p failed: ${ev.result ?? "unknown error"}`);
  const raw = ev.structured_output ?? JSON.parse((ev.result ?? "").replace(/^```(json)?\s*|\s*```$/g, ""));
  const parsed = ProposalSetSchema.parse(raw);
  return {
    ...splitValid(parsed.candidates, max),
    usage: { input_tokens: ev.usage?.input_tokens ?? 0, output_tokens: ev.usage?.output_tokens ?? 0 },
    model: Object.keys(ev.modelUsage ?? {})[0] ?? "claude-cli",
    costUsd: ev.total_cost_usd,
  };
}

/**
 * Same proposer through headless Claude Code (`claude -p`), for users on a Claude subscription with no
 * API key. Tools are disabled; the output is constrained by the same JSON schema.
 */
export async function proposeViaClaudeCli(input: ProposeInput, opts: { model?: string; bin?: string } = {}): Promise<ProposeResult & { costUsd?: number }> {
  const { run } = await import("../exec.js");
  const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(ProposalSetSchema) as Record<string, unknown>;
  const schema = JSON.stringify(jsonSchema);
  const args = ["-p", "--output-format", "json", "--json-schema", schema, "--tools", "", "--no-session-persistence", "--system-prompt", PROPOSER_SYSTEM, "--model", opts.model ?? DEFAULT_PROPOSER_MODEL];
  const r = await run(opts.bin ?? process.env["AUTOTUNE_CLAUDE_BIN"] ?? "claude", args, { input: buildProposerPrompt(input), timeoutMs: 15 * 60_000 });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(`claude -p exited ${r.code}: ${r.stderr.slice(-500)}`);
  return parseCliProposal(r.stdout, input.max);
}
