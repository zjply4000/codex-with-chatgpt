import { randomUUID } from "node:crypto";
import { adminFetch } from "../process/daemon.js";
import { findBridgeObservation, type RuntimeState } from "./runtime.js";
import { SERVICE_NAME } from "../version.js";
import type { AuthStoreDiagnostics } from "../auth/store.js";
import { readTunnelState } from "../tunnel/state.js";

export interface BridgeAdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string; startTimeoutMs?: number };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
  instanceId: string;
  executionDiagnostics: {
    stateStoreFingerprint: string;
    recordCount: number;
    latestTaskId: string | null;
    latestIteration: number | null;
    latestTimestamp: string | null;
  };
  authDiagnostics: AuthStoreDiagnostics;
}

export interface ConnectionCheck { ok: boolean; detail?: string }

export async function probeMcp(port: number): Promise<ConnectionCheck> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }), signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    return { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
  } catch {
    return { ok: false, detail: "MCP 无法访问" };
  }
}

export async function probePublicBridge(url: string, workspaceId: string, instanceId?: string, attempts = 3): Promise<ConnectionCheck> {
  let unavailable = false;
  let mismatch = false;
  const probeCount = Math.max(1, Math.min(10, Math.floor(attempts)));
  for (let attempt = 0; attempt < probeCount; attempt++) {
    const probeUrl = new URL(`${url.replace(/\/+$/, "")}/health`);
    probeUrl.searchParams.set("c2c_instance_probe", randomUUID());
    try {
      const response = await fetch(probeUrl, {
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        unavailable = true;
        continue;
      }
      const health = await response.json() as Record<string, unknown>;
      if (health.service !== SERVICE_NAME || health.status !== "ok" || health.workspaceId !== workspaceId ||
        (instanceId !== undefined && health.instanceId !== instanceId)) mismatch = true;
    } catch {
      unavailable = true;
    }
  }
  if (mismatch) return { ok: false, detail: "PUBLIC_INSTANCE_MISMATCH" };
  if (unavailable) return { ok: false, detail: "PUBLIC_INSTANCE_UNVERIFIED" };
  return { ok: true, detail: `公网 workspace / instance 验证（${probeCount}/${probeCount}）` };
}

export async function verifyBridgeConnection(workspaceId: string, runtime: RuntimeState, publicUrl: string | null) {
  const report: Record<string, ConnectionCheck> = {};
  const observation = await findBridgeObservation(workspaceId);
  report.bridge = { ok: observation.state === "healthy" && observation.runtime.instanceId === runtime.instanceId };
  if (!report.bridge.ok) return { ok: false, report, bridgeRepair: { needed: true } };
  try {
    const info = await adminFetch<BridgeAdminInfo>(runtime, "GET", "/admin/info");
    report.admin = { ok: info.workspaceId === workspaceId && info.port === runtime.port };
  } catch {
    report.admin = { ok: false, detail: "管理权限无法验证" };
  }
  report.mcp = await probeMcp(runtime.port);
  if (publicUrl) {
    const attempts = readTunnelState(workspaceId).provider === "cloudflare-named" ? 3 : 1;
    report.tunnel = await probePublicBridge(publicUrl, workspaceId, runtime.instanceId, attempts);
  }
  return { ok: Object.values(report).every(check => check.ok), report,
    bridgeRepair: { needed: !report.bridge.ok || !report.admin.ok } };
}
