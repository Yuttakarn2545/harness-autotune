import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  shell?: boolean;
  /** Cap captured output so a chatty test runner cannot exhaust memory. */
  maxOutput?: number;
}

/** Run a process and collect its output. Never throws for non-zero exit; check `code`. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 2_000_000;
  return new Promise((resolve, reject) => {
    const so: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    };
    const child = spawn(cmd, args, so);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut, ms: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Run a shell command line (test commands, setup commands). */
export function sh(command: string, opts: Omit<ExecOptions, "shell"> = {}): Promise<ExecResult> {
  return run(command, [], { ...opts, shell: true });
}

export async function git(cwd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run("git", args, { ...opts, cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
