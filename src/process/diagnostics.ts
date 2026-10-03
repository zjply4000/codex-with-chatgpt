import path from "node:path";
import type { ProcessRecord, ProcessSnapshot } from "./inspect.js";
import { processBornAfterParent, sameBridgePath, type VerifiedBridgeProcess } from "./bridge-process.js";

export interface LocalCloudflaredDiagnostics {
  totalForTunnel: number;
  ownedByWorkspace: number;
  otherWorkspace: number;
  orphanedOrMismatched: number;
  pids: number[];
  orphanedPids: number[];
}

export function describeBridgeProcesses(bridges: VerifiedBridgeProcess[]): { ok: boolean; detail: string } {
  return bridges.length > 1
    ? { ok: false, detail: `DUPLICATE_BRIDGE: verified PIDs ${bridges.map((bridge) => bridge.record.pid).join(", ")}` }
    : { ok: true, detail: `verified local Bridges: ${bridges.length}` };
}

export function describeCloudflaredProcesses(diagnostics: LocalCloudflaredDiagnostics): { ok: boolean; detail: string } {
  if (diagnostics.totalForTunnel > 1) {
    return { ok: false, detail: `DUPLICATE_CLOUDFLARED: ${diagnostics.totalForTunnel} local processes for the configured Tunnel UUID` };
  }
  if (diagnostics.orphanedOrMismatched > 0 || diagnostics.otherWorkspace > 0) {
    return { ok: false, detail: `CLOUDFLARED_PARENT_MISMATCH: owned=${diagnostics.ownedByWorkspace}, otherWorkspace=${diagnostics.otherWorkspace}, orphaned=${diagnostics.orphanedOrMismatched}` };
  }
  return { ok: true, detail: `owned local cloudflared: ${diagnostics.ownedByWorkspace}` };
}

function cloudflaredIdentity(record: ProcessRecord): { tunnelId: string; targetPort: number } | null {
  if (!record.executable || !/^cloudflared(?:\.exe)?$/i.test(path.basename(record.executable)) || !record.argv?.length) return null;
  const tunnelIndex = record.argv.indexOf("tunnel");
  const runIndex = record.argv.indexOf("run");
  const urlIndex = record.argv.indexOf("--url");
  if (tunnelIndex < 0 || runIndex < 0 || urlIndex < 0 || urlIndex + 1 >= record.argv.length) return null;
  let url: URL;
  try { url = new URL(record.argv[urlIndex + 1]!); } catch { return null; }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
  const tunnelId = record.argv.slice(runIndex + 1).find((argument) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(argument));
  return tunnelId ? { tunnelId: tunnelId.toLowerCase(), targetPort: Number(url.port) } : null;
}

export function inspectLocalCloudflared(
  snapshot: ProcessSnapshot,
  tunnelId: string,
  workspaceRoot: string,
  verifiedBridges: VerifiedBridgeProcess[]
): LocalCloudflaredDiagnostics {
  const targetId = tunnelId.trim().toLowerCase();
  const roots = new Map(verifiedBridges.map((bridge) => [bridge.record.pid, bridge]));
  const pids: number[] = [];
  const orphanedPids: number[] = [];
  let ownedByWorkspace = 0, otherWorkspace = 0, orphanedOrMismatched = 0;
  for (const record of snapshot.processes) {
    const identity = cloudflaredIdentity(record);
    if (!identity || identity.tunnelId !== targetId) continue;
    pids.push(record.pid);
    const parentBridge = roots.get(record.parentPid);
    if (parentBridge && parentBridge.workspaceRoot && sameBridgePath(parentBridge.workspaceRoot, workspaceRoot) &&
      identity.targetPort === parentBridge.port && processBornAfterParent(record, parentBridge.record)) {
      ownedByWorkspace++;
      continue;
    }
    if (parentBridge && identity.targetPort === parentBridge.port && processBornAfterParent(record, parentBridge.record)) {
      otherWorkspace++;
      continue;
    }
    orphanedOrMismatched++;
    orphanedPids.push(record.pid);
  }
  return { totalForTunnel: pids.length, ownedByWorkspace, otherWorkspace, orphanedOrMismatched,
    pids: pids.sort((a, b) => a - b), orphanedPids: orphanedPids.sort((a, b) => a - b) };
}
