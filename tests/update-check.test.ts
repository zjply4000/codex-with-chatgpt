import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkForUpdates, formatUpdateCheck, type GitRunner } from "../src/update/check.js";
import { cleanup, git, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) cleanup(dir); dirs.length = 0; });
const today = () => new Date(2026, 9, 2, 12);

function fixture() {
  const root = makeTmpDir("update-check"), remote = makeTmpDir("update-remote"), state = makeTmpDir("update-state");
  dirs.push(root, remote, state);
  git(remote, "init", "--bare");
  git(root, "init", "-b", "feature");
  write(root, "source.txt", "initial\n");
  git(root, "add", "."); git(root, "commit", "-m", "initial");
  git(root, "remote", "add", "fork", remote);
  git(root, "push", "--set-upstream", "fork", "feature");
  const calls: string[][] = [];
  const runGit: GitRunner = args => {
    calls.push([...args]);
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), exitCode: result.status };
  };
  const options = { checkout: root, cacheFile: path.join(state, "update.json"), now: today, runGit };
  const inspect = (extra = {}) => checkForUpdates({ ...options, ...extra });
  const head = () => git(root, "rev-parse", "HEAD").trim();
  const localCommit = (message = "local") => {
    write(root, "source.txt", message + "\n"); git(root, "add", "source.txt"); git(root, "commit", "-m", message);
  };
  const remoteCommit = (branch = "feature") => {
    const previous = git(remote, "rev-parse", `refs/heads/${branch}`).trim();
    const tree = git(remote, "rev-parse", `${previous}^{tree}`).trim();
    const next = git(remote, "commit-tree", tree, "-p", previous, "-m", "remote update").trim();
    git(remote, "update-ref", `refs/heads/${branch}`, next);
    return next;
  };
  return { root, remote, state, options, calls, inspect, head, localCommit, remoteCommit };
}

describe("branch-specific safe update inspection", () => {
  it("compares the feature upstream even when the remote default branch differs", () => {
    const f = fixture(); const base = f.head();
    f.localCommit(); git(f.root, "push", "fork", "feature");
    git(f.remote, "update-ref", "refs/heads/main", base); git(f.remote, "symbolic-ref", "HEAD", "refs/heads/main");
    expect(f.inspect()).toMatchObject({ ok: true, updateAvailable: false, reason: "up_to_date", branch: "feature", upstream: "fork/feature", ahead: 0, behind: 0 });
    const fetches = f.calls.filter(args => args.includes("fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain("fork"); expect(fetches[0]).toContain("+refs/heads/feature:refs/remotes/fork/feature");
    expect(f.calls.some(args => args.includes("ls-remote"))).toBe(false);
  });

  it("offers updates only for a clean behind-only branch and preserves HEAD/index/files", () => {
    const f = fixture(), before = f.head(); const next = f.remoteCommit();
    const index = fs.readFileSync(path.join(f.root, ".git/index"));
    const source = fs.readFileSync(path.join(f.root, "source.txt"));
    expect(f.inspect()).toMatchObject({ checked: true, updateAvailable: true, updateBlocked: false, autoUpdateEligible: true, reason: "behind", ahead: 0, behind: 1, remoteCommit: next });
    expect(f.head()).toBe(before); expect(fs.readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
    expect(fs.readFileSync(path.join(f.root, "source.txt"))).toEqual(source);
    expect(f.calls.some(args => args.some(arg => ["pull", "stash", "reset", "checkout", "switch", "clean", "merge", "rebase"].includes(arg)))).toBe(false);
  });

  it("does not treat local commits as an update", () => {
    const f = fixture(); f.localCommit();
    expect(f.inspect()).toMatchObject({ updateAvailable: false, autoUpdateEligible: false, reason: "local_ahead", localAhead: true, ahead: 1, behind: 0 });
  });

  it("blocks a diverged branch", () => {
    const f = fixture(); f.localCommit(); f.remoteCommit();
    expect(f.inspect()).toMatchObject({ updateAvailable: false, updateBlocked: true, autoUpdateEligible: false, reason: "diverged", ahead: 1, behind: 1 });
  });

  it.each(["tracked", "untracked", "staged"])("blocks %s development before fetching or using cache", kind => {
    const f = fixture(); f.remoteCommit();
    if (kind === "tracked") write(f.root, "source.txt", "development\n");
    else if (kind === "staged") { write(f.root, "source.txt", "development\n"); git(f.root, "add", "source.txt"); }
    else write(f.root, "new-recovery.ts", "development\n");
    expect(f.inspect()).toMatchObject({ checked: true, updateAvailable: false, updateBlocked: true, reason: "working_tree_dirty" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
    expect(fs.existsSync(f.options.cacheFile)).toBe(false);
    expect(f.calls.some(args => args.includes("stash") || args.includes("pull"))).toBe(false);
  });

  it("blocks detached HEAD before fetching", () => {
    const f = fixture(); git(f.root, "switch", "--detach");
    expect(f.inspect()).toMatchObject({ updateAvailable: false, updateBlocked: true, reason: "detached" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
  });

  it("blocks a branch without upstream before fetching", () => {
    const f = fixture(); git(f.root, "branch", "--unset-upstream");
    expect(f.inspect()).toMatchObject({ updateAvailable: false, updateBlocked: true, reason: "no_upstream" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
  });

  it("skips network failure without caching or changing the working tree", () => {
    const f = fixture(); const head = f.head();
    const result = f.inspect({ runGit: (args: string[]) => args.includes("fetch") ? { ok: false, stdout: "" } : f.options.runGit(args) });
    expect(result).toMatchObject({ checked: false, updateAvailable: false, updateBlocked: true, reason: "network_failure" });
    expect(f.head()).toBe(head); expect(fs.existsSync(f.options.cacheFile)).toBe(false);
  });

  it("reuses the same clean identity within one day and force bypasses the cache", () => {
    const f = fixture(); f.remoteCommit(); expect(f.inspect().updateAvailable).toBe(true);
    f.calls.length = 0;
    expect(f.inspect()).toMatchObject({ cached: true, updateAvailable: true, ahead: 0, behind: 1 });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
    f.calls.length = 0; expect(f.inspect({ force: true })).toMatchObject({ cached: false, updateAvailable: true });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(true);
  });

  it("never lets a cached positive result hide new dirtiness", () => {
    const f = fixture(); f.remoteCommit(); expect(f.inspect().updateAvailable).toBe(true);
    write(f.root, "source.txt", "unsaved work\n"); f.calls.length = 0;
    expect(f.inspect()).toMatchObject({ updateAvailable: false, autoUpdateEligible: false, reason: "working_tree_dirty", cached: false });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
  });

  it("invalidates same-day cache after switching branches", () => {
    const f = fixture(); f.remoteCommit(); expect(f.inspect().updateAvailable).toBe(true);
    git(f.root, "switch", "-c", "second"); git(f.root, "push", "--set-upstream", "fork", "second");
    f.calls.length = 0;
    expect(f.inspect()).toMatchObject({ branch: "second", upstream: "fork/second", cached: false, updateAvailable: false });
    expect(f.calls.find(args => args.includes("fetch"))).toContain("+refs/heads/second:refs/remotes/fork/second");
  });

  it("invalidates same-day cache after changing local HEAD", () => {
    const f = fixture(); f.remoteCommit(); expect(f.inspect().updateAvailable).toBe(true);
    f.localCommit(); f.calls.length = 0;
    expect(f.inspect()).toMatchObject({ cached: false, updateAvailable: false, reason: "diverged" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(true);
  });

  it("invalidates same-day cache after reconfiguring upstream", () => {
    const f = fixture(); git(f.root, "push", "fork", "HEAD:refs/heads/alternate"); f.remoteCommit();
    expect(f.inspect().updateAvailable).toBe(true);
    git(f.root, "branch", "--set-upstream-to=fork/alternate"); f.calls.length = 0;
    expect(f.inspect()).toMatchObject({ upstream: "fork/alternate", cached: false, updateAvailable: false });
    expect(f.calls.find(args => args.includes("fetch"))).toContain("+refs/heads/alternate:refs/remotes/fork/alternate");
  });

  it("invalidates cache when the tracking ref changes outside this checker", () => {
    const f = fixture(); expect(f.inspect().updateAvailable).toBe(false);
    f.remoteCommit(); git(f.root, "fetch", "fork", "feature"); f.calls.length = 0;
    expect(f.inspect()).toMatchObject({ cached: false, updateAvailable: true });
  });

  it("does not reuse a cache belonging to another checkout or the legacy cache format", () => {
    const f = fixture(); write(f.state, "update.json", JSON.stringify({ date: "2026-10-02", updateAvailable: true, remoteCommit: f.head() }));
    expect(f.inspect()).toMatchObject({ cached: false, updateAvailable: false });
    const other = fixture();
    expect(other.inspect({ cacheFile: f.options.cacheFile })).toMatchObject({ cached: false, updateAvailable: false });
    expect(other.calls.some(args => args.includes("fetch"))).toBe(true);
  });

  it("detects development created during fetch before offering an update", () => {
    const f = fixture(); f.remoteCommit();
    const result = f.inspect({ runGit: (args: string[]) => {
      const value = f.options.runGit(args);
      if (args.includes("fetch")) write(f.root, "new-work.ts", "work\n");
      return value;
    } });
    expect(result).toMatchObject({ updateAvailable: false, updateBlocked: true, autoUpdateEligible: false, reason: "working_tree_dirty" });
    expect(fs.existsSync(f.options.cacheFile)).toBe(false);
  });

  it("supports a configured local upstream without inventing a network remote", () => {
    const f = fixture(); git(f.root, "branch", "base"); git(f.root, "branch", "--set-upstream-to=base");
    expect(f.inspect()).toMatchObject({ upstream: "base", updateAvailable: false, reason: "up_to_date" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
  });

  it("renders skip reasons without falsely announcing a newer version", () => {
    const f = fixture(); write(f.root, "local.ts", "work\n");
    expect(formatUpdateCheck(f.inspect())).toContain("本地开发修改");
    expect(formatUpdateCheck(f.inspect())).not.toContain("发现新版本");
  });

  it("overrides prune configuration so fetching upstream cannot change unrelated tags", () => {
    const f = fixture();
    git(f.root, "config", "fetch.prune", "true"); git(f.root, "config", "fetch.pruneTags", "true");
    git(f.root, "tag", "local-only");
    const before = git(f.root, "rev-parse", "refs/tags/local-only"); f.remoteCommit();
    const remoteHead = git(f.remote, "rev-parse", "refs/heads/feature").trim();
    git(f.remote, "tag", "remote-only", remoteHead);
    expect(f.inspect().updateAvailable).toBe(true);
    expect(git(f.root, "rev-parse", "refs/tags/local-only")).toBe(before);
    expect(git(f.root, "tag", "--list", "remote-only").trim()).toBe("");
  });

  it("invalidates the cache after changing the configured remote URL", () => {
    const f = fixture(); expect(f.inspect().cached).toBe(false);
    const other = fixture(); git(f.root, "remote", "set-url", "fork", other.remote);
    f.calls.length = 0;
    expect(f.inspect().cached).toBe(false);
    expect(f.calls.some(args => args.includes("fetch"))).toBe(true);
  });

  it("refreshes the network cache on a later day", () => {
    const f = fixture(); expect(f.inspect().updateAvailable).toBe(false);
    f.remoteCommit(); f.calls.length = 0;
    expect(f.inspect({ now: () => new Date(2026, 9, 3, 12) })).toMatchObject({ cached: false, updateAvailable: true });
  });

  it("refuses upstream refspecs that would fetch into a local branch", () => {
    const f = fixture(); git(f.root, "config", "remote.fork.fetch", "+refs/heads/*:refs/heads/*");
    const before = f.head();
    expect(f.inspect()).toMatchObject({ updateAvailable: false, reason: "invalid_upstream" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
    expect(f.head()).toBe(before);
  });

  it("refuses a symbolic tracking ref before fetch can update its local branch target", () => {
    const f = fixture(); const before = f.head(); f.remoteCommit();
    git(f.root, "symbolic-ref", "refs/remotes/fork/feature", "refs/heads/feature");
    const index = fs.readFileSync(path.join(f.root, ".git/index"));
    expect(f.inspect()).toMatchObject({ updateAvailable: false, autoUpdateEligible: false, reason: "invalid_upstream" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
    expect(f.head()).toBe(before); expect(fs.readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
    expect(fs.readFileSync(path.join(f.root, "source.txt"), "utf8")).toBe("initial\n");
  });

  it("does not interpret a failed symbolic-ref inspection as proof of a direct ref", () => {
    const f = fixture(); f.remoteCommit();
    const result = f.inspect({ runGit: (args: string[]) => {
      if (args[0] === "symbolic-ref" && args[2] !== "--short") return { ok: false, stdout: "", exitCode: null };
      return f.options.runGit(args);
    } });
    expect(result).toMatchObject({ updateAvailable: false, autoUpdateEligible: false, reason: "invalid_upstream" });
    expect(f.calls.some(args => args.includes("fetch"))).toBe(false);
  });
});
