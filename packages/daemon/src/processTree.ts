export interface ProcessTreeHandle {
	readonly pid: number;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	kill(signal?: number | NodeJS.Signals): void;
}

const GRACEFUL_SHUTDOWN_MS = 1_500;
const FORCE_SHUTDOWN_MS = 500;
const POLL_MS = 20;

function pidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processGroupRunning(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function windowsDescendantPids(rootPid: number): number[] {
	const script = [
		`$root = ${rootPid}`,
		"$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
		"$found = @()",
		"$parents = @($root)",
		"while ($parents.Count -gt 0) {",
		"  $children = @($processes | Where-Object { $parents -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId } | Where-Object { $found -notcontains $_ })",
		"  if ($children.Count -eq 0) { break }",
		"  $found += $children",
		"  $parents = $children",
		"}",
		"[Console]::Out.Write(($found -join ','))",
	].join("; ");
	const result = Bun.spawnSync({
		cmd: [
			"powershell.exe",
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script,
		],
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return [];
	return new TextDecoder()
		.decode(result.stdout)
		.split(",")
		.map((value) => Number(value))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function signalWindowsTree(proc: ProcessTreeHandle, force: boolean): number[] {
	const descendants = windowsDescendantPids(proc.pid);
	const roots = proc.exitCode === null ? [proc.pid] : descendants;
	for (const pid of roots) {
		const command = ["taskkill", "/PID", String(pid), "/T"];
		if (force) command.push("/F");
		Bun.spawnSync({ cmd: command, stdout: "ignore", stderr: "ignore" });
	}
	if (proc.exitCode === null && pidRunning(proc.pid))
		proc.kill(force ? "SIGKILL" : "SIGTERM");
	return descendants;
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

async function waitFor(
	check: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(POLL_MS);
	}
	return true;
}

async function stopWindowsProcessTree(proc: ProcessTreeHandle): Promise<void> {
	let descendants = signalWindowsTree(proc, false);
	const stoppedGracefully = await waitFor(
		() =>
			proc.exitCode !== null && descendants.every((pid) => !pidRunning(pid)),
		GRACEFUL_SHUTDOWN_MS,
	);
	if (stoppedGracefully) return;

	descendants = [
		...new Set([...descendants, ...signalWindowsTree(proc, true)]),
	];
	await Promise.all([
		proc.exited,
		waitFor(
			() => descendants.every((pid) => !pidRunning(pid)),
			FORCE_SHUTDOWN_MS,
		),
	]);
}

/** Terminate a detached subprocess and every descendant in its process group. */
export async function stopProcessTree(proc: ProcessTreeHandle): Promise<void> {
	if (process.platform === "win32") {
		await stopWindowsProcessTree(proc);
		return;
	}
	if (proc.exitCode === null || processGroupRunning(proc.pid))
		signalProcessTree(proc, "SIGTERM");

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
