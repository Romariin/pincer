export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thin wrapper around the `git` CLI, bound to a working directory. */
export class Git {
  constructor(private readonly cwd: string) {}

  private async run(args: string[]): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  }

  private async runOk(args: string[]): Promise<GitResult> {
    const r = await this.run(args);
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r;
  }

  async isInsideWorkTree(): Promise<boolean> {
    const r = await this.run(["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async isDirty(): Promise<boolean> {
    const r = await this.runOk(["status", "--porcelain"]);
    return r.stdout.trim().length > 0;
  }

  async dirtyFiles(): Promise<string[]> {
    const r = await this.runOk(["status", "--porcelain"]);
    return r.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      // porcelain lines are "XY <path>"; the path starts at column 3.
      .map((l) => l.slice(3));
  }

  async currentBranch(): Promise<string> {
    const r = await this.runOk(["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.stdout.trim();
  }

  async headSha(): Promise<string> {
    const r = await this.runOk(["rev-parse", "HEAD"]);
    return r.stdout.trim();
  }

  async createBranch(name: string): Promise<void> {
    await this.runOk(["checkout", "-b", name]);
  }

  async checkout(ref: string): Promise<void> {
    await this.runOk(["checkout", ref]);
  }

  /** Stage everything and commit; returns the new sha, or null if there was nothing to commit. */
  async commitAll(message: string): Promise<string | null> {
    await this.runOk(["add", "-A"]);
    if (!(await this.isDirty())) return null;
    await this.runOk(["commit", "--no-verify", "-m", message]);
    return this.headSha();
  }

  async resetHard(ref: string): Promise<void> {
    await this.runOk(["reset", "--hard", ref]);
  }

  async merge(
    branch: string,
    message: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; conflict: true }> {
    const r = await this.run(["merge", "--no-ff", branch, "-m", message]);
    if (r.code !== 0) {
      await this.run(["merge", "--abort"]);
      return { ok: false, conflict: true };
    }
    return { ok: true, sha: await this.headSha() };
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await this.runOk(["branch", force ? "-D" : "-d", name]);
  }

  async branchExists(name: string): Promise<boolean> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    return r.code === 0;
  }

  async listBranches(prefix?: string): Promise<string[]> {
    const r = await this.runOk(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    const all = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return prefix ? all.filter((b) => b.startsWith(prefix)) : all;
  }
}
