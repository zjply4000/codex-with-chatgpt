import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { findBridgeObservation, findLiveBridge, matchesBridgeInstance, probeBridge, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { assertMaintenanceAccess } from "./maintenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number; recoveryToken?: string } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  assertMaintenanceAccess(workspace.id, opts.recoveryToken);
  const observation = await findBridgeObservation(workspace.id);
  assertMaintenanceAccess(workspace.id, opts.recoveryToken);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
      windowsHide: true,
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export class BridgeAdminUnavailableError extends Error {
  constructor(public readonly reason: "stale_runtime" | "admin_unavailable") {
    super(`Bridge admin capability unavailable (${reason}); refusing unverified instance management.`);
  }
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000,
  recoveryToken?: string
): Promise<T> {
  if (method === "POST") {
    try { assertMaintenanceAccess(runtime.workspaceId, recoveryToken); }
    catch { throw new BridgeAdminUnavailableError("admin_unavailable"); }
  }
  const health = await probeBridge(runtime.port);
  if (!health) throw new BridgeAdminUnavailableError("admin_unavailable");
  if (!matchesBridgeInstance(runtime, health)) throw new BridgeAdminUnavailableError("stale_runtime");
  if (method === "POST") {
    try { assertMaintenanceAccess(runtime.workspaceId, recoveryToken); }
    catch { throw new BridgeAdminUnavailableError("admin_unavailable"); }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${runtime.adminToken}` },
        signal: controller.signal,
      });
    } catch {
      throw new BridgeAdminUnavailableError("admin_unavailable");
    }
    const body = (await response.json().catch(() => {
      if (response.ok) throw new BridgeAdminUnavailableError("admin_unavailable");
      return {};
    })) as T & { message?: string };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new BridgeAdminUnavailableError("admin_unavailable");
      }
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  assertMaintenanceAccess(workspace.id);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "unknown") {
    throw new Error(`Bridge state is uncertain (${observation.reason}); refusing to stop an unverified instance.`);
  }
  if (observation.state === "stopped") return false;
  await adminFetch(observation.runtime, "POST", "/admin/shutdown", 5000);
  return true;
}
