import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { applyCandidate, renderDiff, validateCandidate, type Candidate } from "../src/propose/types.js";
import { ruleProposals } from "../src/propose/rules.js";
import { buildProposerPrompt, proposeWithClaude } from "../src/propose/llm.js";
import { mineSessions } from "../src/sessions/report.js";
import { parseSessionText } from "../src/sessions/parse.js";
import { detectAll } from "../src/sessions/detectors.js";
import { summarize } from "../src/sessions/report.js";
import { frictionTranscript } from "./helpers.js";

const session = parseSessionText(frictionTranscript());
const report = summarize([session], [detectAll(session)], "fixture");

const good: Candidate = {
  id: "verify-before-done",
  title: "t",
  rationale: "r",
  targets: ["unverified-done"],
  edits: [{ file: "CLAUDE.md", mode: "append", content: "## Verify\n\nRun `npm test`." }],
};

describe("candidates", () => {
  it("validates edit targets and size", () => {
    expect(validateCandidate(good)).toEqual([]);
    expect(validateCandidate({ ...good, edits: [{ file: "src/index.ts", mode: "create", content: "x" }] })[0]).toMatch(/not allowed/);
    expect(validateCandidate({ ...good, edits: [{ file: "CLAUDE.md", mode: "create", content: "x" }] })[0]).toMatch(/appended/);
    expect(validateCandidate({ ...good, edits: [{ file: ".claude/skills/run-tests/SKILL.md", mode: "create", content: "x".repeat(3000) }] })[0]).toMatch(/too large/);
    expect(validateCandidate({ ...good, id: "Bad Id" })[0]).toMatch(/bad id/);
  });
  it("appends to CLAUDE.md and renders a diff", () => {
    const cur = new Map([["CLAUDE.md", "# Repo\n\nUse pnpm.\n"]]);
    const [f] = applyCandidate(cur, good);
    expect(f!.content).toBe("# Repo\n\nUse pnpm.\n\n## Verify\n\nRun `npm test`.\n");
    expect(renderDiff(cur, good)).toContain("+## Verify");
    expect(applyCandidate(new Map(), good)[0]!.content).toBe("## Verify\n\nRun `npm test`.\n");
  });
});

describe("rule proposer", () => {
  it("emits one valid candidate per observed category", () => {
    const cs = ruleProposals(report, "npm test");
    expect(cs.map((c) => c.id).sort()).toEqual(["confirm-scope", "no-blind-retries", "read-once", "trim-output", "verify-before-done"]);
    for (const c of cs) expect(validateCandidate(c)).toEqual([]);
    expect(cs.find((c) => c.id === "verify-before-done")!.edits[0]!.content).toContain("`npm test`");
  });
  it("emits nothing for a clean report", async () => {
    expect(ruleProposals(await mineSessions([]))).toEqual([]);
  });
});

describe("LLM proposer (mocked client)", () => {
  it("sends the friction report, validates output, drops invalid candidates", async () => {
    let sent: Record<string, unknown> | undefined;
    const client = {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            sent = params;
            return {
              model: "claude-opus-5-5",
              stop_reason: "end_turn",
              usage: { input_tokens: 1200, output_tokens: 300 },
              parsed_output: { candidates: [good, { ...good, id: "evil", edits: [{ file: ".claude/settings.json", mode: "create", content: "{}" }] }] },
            };
          },
        },
      },
    } as unknown as Anthropic;
    const res = await proposeWithClaude({ report, currentClaudeMd: "# Repo", repoFacts: "scripts: test", max: 3 }, { client });
    expect(res.candidates.map((c) => c.id)).toEqual(["verify-before-done"]);
    expect(res.rejected[0]!.candidate.id).toBe("evil");
    expect(sent).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" } });
    expect(String((sent!["messages"] as { content: string }[])[0]!.content)).toContain("Same command failed repeatedly");
  });
  it("surfaces refusals", async () => {
    const client = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", usage: {}, parsed_output: null }) } } } as unknown as Anthropic;
    await expect(proposeWithClaude({ report, currentClaudeMd: "", repoFacts: "", max: 1 }, { client })).rejects.toThrow(/refusal/);
  });
  it("prompt mentions the current CLAUDE.md", () => {
    expect(buildProposerPrompt({ report, currentClaudeMd: "Use pnpm.", repoFacts: "", max: 2 })).toContain("Use pnpm.");
  });
});

describe("claude-cli proposer output", () => {
  it("reads structured_output and validates candidates", async () => {
    const { parseCliProposal } = await import("../src/propose/llm.js");
    const line = JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.12, structured_output: { candidates: [good] }, usage: { input_tokens: 9, output_tokens: 8 }, modelUsage: { "claude-opus-5-5": {} } });
    const r = parseCliProposal(`noise\n${line}\n`, 3);
    expect(r.candidates.map((c) => c.id)).toEqual(["verify-before-done"]);
    expect(r.costUsd).toBe(0.12);
    expect(r.model).toBe("claude-opus-5-5");
  });
  it("falls back to JSON in the result text and surfaces errors", async () => {
    const { parseCliProposal } = await import("../src/propose/llm.js");
    expect(parseCliProposal(JSON.stringify({ result: "```json\n" + JSON.stringify({ candidates: [] }) + "\n```" }), 3).candidates).toEqual([]);
    expect(() => parseCliProposal(JSON.stringify({ is_error: true, result: "auth" }), 3)).toThrow(/auth/);
  });
});
