import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getRuntimeStateDir } from "../config/paths.js";

interface BridgeLeaseRecord {
  pid: number;
  instanceId: string;
  leaseId: string;
}

export function bridgeLeaseFile(workspaceId: string): string {
  return path.join(getRuntimeStateDir(), "runtime", `${workspaceId}.bridge.lock`);
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function acquireBridgeLease(workspaceId: string, instanceId: string): Promise<() => void> {
  const file = bridgeLeaseFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const record: BridgeLeaseRecord = { pid: process.pid, instanceId, leaseId: randomUUID() };
  const contents = JSON.stringify(record);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, contents, "utf8"); }
      finally { fs.closeSync(fd); }
      try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === contents) fs.unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let before: string;
    let existing: BridgeLeaseRecord;
    try {
      before = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(before) as Partial<BridgeLeaseRecord>;
      if (!Number.isSafeInteger(parsed.pid) || !parsed.instanceId || !parsed.leaseId) {
        throw new Error("invalid lease");
      }
      existing = parsed as BridgeLeaseRecord;
    } catch {
      throw new Error("BRIDGE_IDENTITY_UNVERIFIED: Bridge singleton lease is unreadable; refusing another instance.");
    }

    if (!pidIsGone(existing.pid)) {
      throw new Error("DUPLICATE_BRIDGE: A Bridge process already holds the workspace singleton lease.");
    }

    try {
      if (fs.readFileSync(file, "utf8") !== before) continue;
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("BRIDGE_IDENTITY_UNVERIFIED: Stale Bridge lease changed during recovery.");
    }
  }
  throw new Error("BRIDGE_IDENTITY_UNVERIFIED: Could not atomically acquire the workspace Bridge lease.");
}
