export interface ProcessTreeHandle {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
}

const GRACEFUL_SHUTDOWN_MS = 1_500;
const FORCE_SHUTDOWN_MS = 500;
const POLL_MS = 20;

function processGroupRunning(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalWindowsTree(proc: ProcessTreeHandle, force: boolean): void {
  const command = ["taskkill", "/PID", String(proc.pid), "/T"];
  if (force) command.push("/F");
  const result = Bun.spawnSync({ cmd: command, stdout: "ignore", stderr: "ignore" });
  if (result.exitCode !== 0 && proc.exitCode === null) proc.kill(force ? "SIGKILL" : "SIGTERM");
}

export function signalProcessTree(
  proc: ProcessTreeHandle,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (process.platform === "win32") {
    signalWindowsTree(proc, signal === "SIGKILL");
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    if (proc.exitCode === null) proc.kill(signal);
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}

/** Terminate a detached subprocess and every descendant in its process group. */
export async function stopProcessTree(proc: ProcessTreeHandle): Promise<void> {
  if (proc.exitCode === null || processGroupRunning(proc.pid)) signalProcessTree(proc, "SIGTERM");

  const stoppedGracefully = await waitFor(
    () => proc.exitCode !== null && !processGroupRunning(proc.pid),
    GRACEFUL_SHUTDOWN_MS,
  );
  if (!stoppedGracefully) {
    signalProcessTree(proc, "SIGKILL");
    await Promise.all([
      proc.exited,
      waitFor(() => !processGroupRunning(proc.pid), FORCE_SHUTDOWN_MS),
    ]);
  }
}
