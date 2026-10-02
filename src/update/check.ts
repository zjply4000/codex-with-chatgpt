import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { getStateDir } from "../config/paths.js";

export type GitRunner = (args: string[]) => { ok: boolean; stdout: string; exitCode?: number | null };
export type UpdateReason = "working_tree_dirty" | "detached" | "no_upstream" | "invalid_upstream" |
  "git_unavailable" | "network_failure" | "state_changed" | "history_unavailable" |
  "up_to_date" | "local_ahead" | "diverged" | "behind";

export interface UpdateCheck {
  ok: true;
  checked: boolean;
  cached: boolean;
  updateAvailable: boolean;
  updateBlocked: boolean;
  autoUpdateEligible: boolean;
  reason: UpdateReason;
  checkout: string;
  branch?: string;
  upstream?: string;
  upstreamRemote?: string;
  upstreamBranch?: string;
  upstreamRef?: string;
  remoteIdentity?: string;
  localCommit?: string;
  remoteCommit?: string;
  ahead?: number;
  behind?: number;
  localAhead?: boolean;
}

interface Identity {
  checkout: string;
  branch: string;
  upstream: string;
  upstreamRef: string;
  remote: string;
  mergeRef: string;
  remoteIdentity: string;
  localCommit: string;
}
interface Cache { schema: 1; date: string; identity: Identity; remoteCommit: string; }
interface LocalState { identity?: Identity; reason?: UpdateReason; }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: Identity | undefined, b: Identity | undefined) => JSON.stringify(a) === JSON.stringify(b);

function localState(checkout: string, git: GitRunner): LocalState {
  const status = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (!status.ok) return { reason: "git_unavailable" };
  if (status.stdout) return { reason: "working_tree_dirty" };
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch.ok || !branch.stdout) return { reason: "detached" };
  const head = git(["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { reason: "git_unavailable" };
  const remote = git(["config", "--get", `branch.${branch.stdout}.remote`]);
  const merge = git(["config", "--get", `branch.${branch.stdout}.merge`]);
  if (!remote.ok || !merge.ok || !remote.stdout || !merge.stdout) return { reason: "no_upstream" };
  const upstream = git(["for-each-ref", "--format=%(upstream)%00%(upstream:short)", `refs/heads/${branch.stdout}`]);
  const [upstreamRef, upstreamName] = upstream.stdout.split("\0");
  if (!upstream.ok || !upstreamRef || !upstreamName) return { reason: "no_upstream" };
  // A remote fetch must never target a local branch or tag, even with unusual refspecs.
  if (!merge.stdout.startsWith("refs/heads/") || !git(["check-ref-format", merge.stdout]).ok ||
    !git(["check-ref-format", upstreamRef]).ok ||
    (remote.stdout !== "." && (!upstreamRef.startsWith("refs/") || /^refs\/(heads|tags)\//.test(upstreamRef)))) {
    return { reason: "invalid_upstream" };
  }
  // Fetch dereferences symbolic destinations; such an alias could advance a local branch.
  if (remote.stdout !== ".") {
    const symbolic = git(["symbolic-ref", "--quiet", upstreamRef]);
    // Exit 1 proves a non-symbolic ref. Timeouts/errors cannot establish that fact.
    if (symbolic.ok || symbolic.exitCode !== 1) return { reason: "invalid_upstream" };
  }
  const url = remote.stdout === "." ? { ok: true, stdout: checkout } : git(["remote", "get-url", remote.stdout]);
  if (!url.ok || !url.stdout) return { reason: "invalid_upstream" };
  return { identity: { checkout, branch: branch.stdout, upstream: upstreamName, upstreamRef,
    remote: remote.stdout, mergeRef: merge.stdout, remoteIdentity: hash(url.stdout), localCommit: head.stdout } };
}

/** Inspect only the C2C checkout. Fetching updates one upstream tracking ref, never HEAD or files. */
export function checkForUpdates(options: {
  checkout: string;
  cacheFile?: string;
  force?: boolean;
  now?: () => Date;
  runGit?: GitRunner;
}): UpdateCheck {
  let checkout = path.resolve(options.checkout);
  try { checkout = fs.realpathSync.native(checkout); } catch { /* Git will report an unavailable checkout. */ }
  const git: GitRunner = options.runGit ?? (args => {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 15_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), exitCode: result.status };
  });
  const base: UpdateCheck = { ok: true, checked: true, cached: false, updateAvailable: false,
    updateBlocked: true, autoUpdateEligible: false, reason: "git_unavailable", checkout };
  const block = (reason: UpdateReason): UpdateCheck => ({ ...base, reason,
    checked: reason !== "network_failure" && reason !== "git_unavailable" });
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root.ok) return block("git_unavailable");
  try { if (fs.realpathSync.native(root.stdout) !== checkout) return block("git_unavailable"); }
  catch { return block("git_unavailable"); }

  // Local eligibility always precedes cache lookup and network access.
  const initial = localState(checkout, git);
  if (!initial.identity) return block(initial.reason!);
  const identity = initial.identity;
  Object.assign(base, { branch: identity.branch, upstream: identity.upstream, localCommit: identity.localCommit,
    upstreamRemote: identity.remote, upstreamBranch: identity.mergeRef, upstreamRef: identity.upstreamRef,
    remoteIdentity: identity.remoteIdentity });
  const file = options.cacheFile ?? path.join(getStateDir(), `update-check-${hash(checkout).slice(0, 20)}.json`);
  const date = (options.now?.() ?? new Date()).toLocaleDateString("en-CA");
  const tracked = git(["rev-parse", "--verify", `${identity.upstreamRef}^{commit}`]);
  let cache: Cache | null = null;
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")) as Cache; } catch { /* Missing or old cache requires inspection. */ }
  const cached = !options.force && cache?.schema === 1 && cache.date === date &&
    equal(cache.identity, identity) && tracked.ok && cache.remoteCommit === tracked.stdout;
  if (!cached && identity.remote !== ".") {
    const fetched = git(["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--no-write-fetch-head",
      "--no-auto-maintenance", "--refmap=", "--", identity.remote, `+${identity.mergeRef}:${identity.upstreamRef}`]);
    if (!fetched.ok) return block("network_failure");
  }
  const refreshed = localState(checkout, git);
  if (!refreshed.identity) return block(refreshed.reason!);
  if (!equal(identity, refreshed.identity)) return block("state_changed");
  const remote = git(["rev-parse", "--verify", `${identity.upstreamRef}^{commit}`]);
  if (!remote.ok) return block("history_unavailable");
  const counts = git(["rev-list", "--left-right", "--count", `${identity.localCommit}...${remote.stdout}`]);
  if (!counts.ok || !/^\d+\s+\d+$/.test(counts.stdout)) return block("history_unavailable");
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return block("history_unavailable");
  const reason: UpdateReason = ahead > 0 ? (behind > 0 ? "diverged" : "local_ahead") : behind > 0 ? "behind" : "up_to_date";
  if (reason === "behind" && !git(["merge-base", "--is-ancestor", identity.localCommit, remote.stdout]).ok) {
    return block("history_unavailable");
  }
  const finalState = localState(checkout, git);
  if (!finalState.identity) return block(finalState.reason!);
  const finalRemote = git(["rev-parse", "--verify", `${identity.upstreamRef}^{commit}`]);
  if (!equal(identity, finalState.identity) || !finalRemote.ok || remote.stdout !== finalRemote.stdout) return block("state_changed");
  const result: UpdateCheck = { ...base, checked: !cached, cached: Boolean(cached), reason, ahead, behind,
    remoteCommit: remote.stdout, localAhead: ahead > 0, updateAvailable: reason === "behind",
    autoUpdateEligible: reason === "behind", updateBlocked: reason === "diverged" };
  if (!cached) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const entry: Cache = { schema: 1, date, identity, remoteCommit: remote.stdout };
      fs.writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
    } catch { /* Cache availability does not determine update eligibility or block normal work. */ }
  }
  return result;
}

export function formatUpdateCheck(result: UpdateCheck): string {
  switch (result.reason) {
    case "behind": return `发现新版本（${result.upstream}：落后 ${result.behind} 个提交，可 fast-forward）。`;
    case "working_tree_dirty": return "检测到当前 C2C checkout 有本地开发修改，已跳过自动更新。";
    case "local_ahead": return "当前分支有本地提交，已跳过自动更新。";
    case "diverged": return "当前分支与 upstream 已分叉，已跳过自动更新。";
    case "detached": return "当前 checkout 是 detached HEAD，已跳过自动更新。";
    case "no_upstream": return "当前分支未配置 upstream，已跳过自动更新。";
    case "invalid_upstream": return "无法安全使用当前 configured upstream，已跳过自动更新。";
    case "network_failure": return "无法检查当前 upstream（网络或远端不可用），已跳过自动更新。";
    case "state_changed": return "检查期间 checkout 状态已改变，已跳过自动更新。";
    case "history_unavailable": return "无法确认当前 upstream 的提交关系，已跳过自动更新。";
    case "git_unavailable": return "无法读取 C2C checkout 的 Git 状态，已跳过自动更新。";
    case "up_to_date": return "当前分支与 configured upstream 一致。";
  }
}
