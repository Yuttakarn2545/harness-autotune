import { writeInto } from "../tasks/verify.js";
import type { Task } from "../tasks/types.js";
import { mulberry32 } from "./stats.js";
import type { Agent, AgentOptions, AgentRun } from "./agent.js";

/**
 * Deterministic stand-in for Claude Code, used by tests and `bench --agent scripted` to exercise the
 * whole pipeline (seal → run → score → stats → report) offline. With probability `solveRate` it writes
 * the task's reference solution; otherwise it leaves the workspace alone. Its numbers are synthetic and
 * must never be reported as measurements.
 */
export class ScriptedAgent implements Agent {
  name = "scripted";
  private calls = 0;
  constructor(
    private solveRate: number | ((task: Task, workspace: string) => number) = 1,
    private costUsd = 0.1,
    private seed = 7,
  ) {}

  async run(workspace: string, _instruction: string, _opts: AgentOptions, task?: Task): Promise<AgentRun> {
    if (!task) throw new Error("ScriptedAgent needs the task");
    const rand = mulberry32(this.seed + this.calls++ * 7919);
    const p = typeof this.solveRate === "function" ? this.solveRate(task, workspace) : this.solveRate;
    const solve = rand() < p;
    if (solve) await writeInto(workspace, task.reference);
    return {
      ok: true,
      costUsd: this.costUsd,
      costSource: "computed",
      tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      turns: solve ? 3 : 6,
      wallMs: 1,
      resultText: solve ? "applied reference" : "gave up",
      toolInputs: [],
    };
  }
}
