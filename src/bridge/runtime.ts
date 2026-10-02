import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
  /** Missing on legacy records, which cannot establish instance identity. */
  instanceId?: string;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(getStateDir(), "runtime", `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
  instanceId?: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" | "stale_runtime" };

/** Instance identity is public metadata, never an admin credential. */
export function matchesBridgeInstance(runtime: RuntimeState, health: HealthPayload): boolean {
  return runtime.service === SERVICE_NAME && health.service === SERVICE_NAME &&
    runtime.workspaceId === health.workspaceId &&
    typeof runtime.instanceId === "string" && runtime.instanceId.length > 0 &&
    runtime.instanceId === health.instanceId;
}

export const BRIDGE_RUNTIME_REPAIR_MESSAGE =
  "连接仍可能在运行，但本地运行记录已失效或无法验证实例身份，不能自动恢复管理权限。" +
  "请在目标工作目录执行 c2c bridge recover；可先用 c2c bridge recover --dry-run 查看只读计划。" +
  "命令无法安全验证旧进程时需要人工维护；不要绕过验证、启动第二实例、重新配对或重建 ChatGPT Connector。";

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health && health.workspaceId === workspaceId) {
    if (!matchesBridgeInstance(runtime, health)) {
      return { state: "unknown", runtime, reason: "stale_runtime" };
    }
    return { state: "healthy", runtime };
  }
  if (health) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  // A legacy record cannot identify which process its saved PID belonged to.
  if (typeof runtime.instanceId !== "string" || !runtime.instanceId) {
    return { state: "unknown", runtime, reason: "stale_runtime" };
  }

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
