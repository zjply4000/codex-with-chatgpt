import type { ProcessInspector, ProcessRecord, ProcessSnapshot } from "./inspect.js";
import { descendantProcessTree, identifyBridgeProcess, sameBridgePath } from "./bridge-process.js";

export interface RetirementDependencies {
  inspector: ProcessInspector;
  workspaceRoot: string;
  snapshot: ProcessSnapshot;
  roots: ProcessRecord[];
  assumedPort?: number;
  timeoutMs?: number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  portFree?: () => Promise<boolean>;
}

export interface RetirementResult {
  bridges: number;
  descendants: number;
  ports: number[];
  records: ProcessRecord[];
}

function listenersFor(record: ProcessRecord, snapshot: ProcessSnapshot, assumedPort?: number): number[] {
  const owners = snapshot.listenerOwners;
  if (owners) return [...new Set(owners.filter((owner) => owner.pid === record.pid).map((owner) => owner.port))];
  return assumedPort !== undefined && snapshot.listeners.includes(record.pid) ? [assumedPort] : [];
}

export async function retireVerifiedBridgeTree(deps: RetirementDependencies): Promise<RetirementResult> {
  if (!deps.roots.length) throw new Error("No verified Bridge roots were selected for retirement.");
  const roots = new Map(deps.roots.map((record) => [record.pid, record]));
  const tree = descendantProcessTree(deps.snapshot, deps.roots);
  if (tree.blockers.length) throw new Error(tree.blockers.join(" "));
  const ports = [...new Set(deps.roots.flatMap((root) => listenersFor(root, deps.snapshot, deps.assumedPort)))];
  for (const root of deps.roots) {
    const identity = identifyBridgeProcess(root);
    if (!identity.verified || !identity.workspaceRoot || !sameBridgePath(identity.workspaceRoot, deps.workspaceRoot) ||
      !root.startId || !root.executable || root.pid === process.pid || listenersFor(root, deps.snapshot, deps.assumedPort).length !== 1) {
      throw new Error(`PID ${root.pid}: Bridge root or listener identity is not fully verified.`);
    }
  }

  for (const record of tree.records) await deps.inspector.terminate(record);
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.timeoutMs ?? 10_000);
  const oldPids = new Set(tree.records.map((record) => record.pid));
  const oldIdentities = new Map(tree.records.map((record) => [record.pid, record.startId]));
  const probePort = deps.assumedPort ?? ports[0]!;

  while (true) {
    const snapshot = await deps.inspector.snapshot(probePort);
    const survivors = snapshot.processes.filter((record) => oldIdentities.get(record.pid) === record.startId);
    for (const record of snapshot.processes) {
      const identity = identifyBridgeProcess(record);
      if (!identity.related || !identity.workspaceRoot || !sameBridgePath(identity.workspaceRoot, deps.workspaceRoot)) continue;
      if (oldIdentities.get(record.pid) !== record.startId) {
        throw new Error(`PID ${record.pid}: another same-workspace Bridge appeared during retirement.`);
      }
    }
    const oldListenersRemain = (snapshot.listenerOwners ?? [])
      .some((owner) => ports.includes(owner.port) && oldPids.has(owner.pid));
    const legacyOldListenerRemains = !snapshot.listenerOwners && snapshot.listeners.some((pid) => oldPids.has(pid));
    const portStillFree = deps.portFree ? await deps.portFree() : true;
    if (!survivors.length && !oldListenersRemain && !legacyOldListenerRemains && portStillFree) {
      return { bridges: roots.size, descendants: tree.records.length - roots.size, ports, records: tree.records };
    }
    if (now() >= deadline) throw new Error("Verified Bridge processes, cloudflared descendants or old listeners did not retire before timeout.");
    await pause(200);
  }
}
