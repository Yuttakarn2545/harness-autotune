import type { FrictionReport } from "../sessions/report.js";
import type { Candidate } from "./types.js";

/**
 * Offline, deterministic proposer: one template edit per friction category that shows up.
 * It is a baseline to compare the LLM proposer against, and lets the whole loop run with no API key.
 */
export function ruleProposals(report: FrictionReport, testCommand?: string): Candidate[] {
  const has = (cat: string) => (report.categories.find((c) => c.category === cat)?.findings ?? 0) > 0;
  const top = (cat: string) => report.categories.find((c) => c.category === cat)?.topKeys.map((k) => k.key) ?? [];
  const out: Candidate[] = [];

  if (has("unverified-done")) {
    out.push({
      id: "verify-before-done",
      title: "Run the tests before claiming done",
      rationale: "Transcripts show turns that edited code and then reported success without running any test or build command.",
      targets: ["unverified-done"],
      edits: [
        {
          file: "CLAUDE.md",
          mode: "append",
          content: `## Verification\n\nAfter changing code, run ${testCommand ? `\`${testCommand}\`` : "the project's test command"} and read the result before saying the work is done. If you could not run it, say so plainly.`,
        },
      ],
    });
  }
  if (has("repeated-failing-command")) {
    const keys = top("repeated-failing-command").slice(0, 4);
    out.push({
      id: "no-blind-retries",
      title: "Diagnose a failing command before re-running it",
      rationale: `The same commands failed repeatedly within a session${keys.length ? ` (${keys.map((k) => `\`${k}\``).join(", ")})` : ""}; each retry re-sent the whole context.`,
      targets: ["repeated-failing-command"],
      edits: [
        {
          file: "CLAUDE.md",
          mode: "append",
          content: `## When a command fails\n\nRead the error output and change something (arguments, working directory, a missing setup step) before running it again. Never re-run an identical failing command.`,
        },
      ],
    });
  }
  if (has("repeated-read")) {
    out.push({
      id: "read-once",
      title: "Avoid re-reading unchanged files",
      rationale: "Files were read three or more times with no edit in between, re-paying for the same context.",
      targets: ["repeated-read"],
      edits: [
        {
          file: "CLAUDE.md",
          mode: "append",
          content: `## Reading code\n\nRead a file once and keep what you need; to re-check a detail use Grep or a line range instead of re-reading the whole file.`,
        },
      ],
    });
  }
  if (has("token-heavy-turn")) {
    out.push({
      id: "trim-output",
      title: "Keep tool output small",
      rationale: "A few turns cost many times the median, often from very large tool outputs.",
      targets: ["token-heavy-turn"],
      edits: [
        {
          file: "CLAUDE.md",
          mode: "append",
          content: `## Output size\n\nWhen a command may print a lot (test runs, logs, builds), limit it (\`| tail -n 60\`, a reporter flag, or a narrower test filter).`,
        },
      ],
    });
  }
  if (has("user-correction")) {
    out.push({
      id: "confirm-scope",
      title: "Restate scope before large changes",
      rationale: "Users had to correct the agent after it acted on a misread request.",
      targets: ["user-correction"],
      edits: [
        {
          file: "CLAUDE.md",
          mode: "append",
          content: `## Scope\n\nBefore a change that touches several files, state in one sentence what you are about to change, then do only that.`,
        },
      ],
    });
  }
  return out;
}
