import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { probeBridge, type HealthPayload } from "../bridge/runtime.js";
import { SERVICE_NAME } from "../version.js";
import type { ProcessRecord, ProcessSnapshot } from "./inspect.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const trustedEntries = ["dist/cli/index.js", "bin/c2c.js", "src/cli/index.ts"]
  .map((file) => path.join(checkout, file));

export interface BridgeProcessIdentity {
  related: boolean;
  verified: boolean;
  workspaceRoot?: string;
  /** Normalized argv workspace path, even if its directory no longer exists. */
  workspacePathCandidate?: string;
  workspacePathCandidates?: string[];
  workspaceArgumentCount?: number;
  workspaceArgumentsValid?: boolean;
}

export function sameBridgePath(left: string, right: string): boolean {
  if (left === right) return true;
  if (process.platform !== "win32" && process.platform !== "darwin") return false;
  if (left.toLowerCase() !== right.toLowerCase()) return false;
  try {
    const a = fs.statSync(left), b = fs.statSync(right);
    return a.dev === b.dev && a.ino !== 0 && a.ino === b.ino;
  } catch {
    return false;
  }
}

function canonical(input: string, cwd: string | null): string {
  if (!path.isAbsolute(input) && !cwd) throw new Error("relative process path has no cwd");
  return fs.realpathSync.native(path.resolve(cwd ?? "", input));
}

function lexicalWorkspacePath(input: string, cwd: string | null): string | undefined {
  if (!path.isAbsolute(input) && !cwd) return undefined;
  try { return path.normalize(path.resolve(cwd ?? "", input)); }
  catch { return undefined; }
}

function sameLexicalWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function bridgeWorkspaceRelation(
  identity: BridgeProcessIdentity,
  workspaceRoot: string
): "same-canonical" | "other-canonical" | "same-candidate" | "other-candidate" | "unknown" {
  if (identity.workspaceRoot) {
    return sameBridgePath(identity.workspaceRoot, workspaceRoot) ? "same-canonical" : "other-canonical";
  }
  const candidates = identity.workspacePathCandidates ?? (identity.workspacePathCandidate ? [identity.workspacePathCandidate] : []);
  const argumentCount = identity.workspaceArgumentCount ?? (identity.workspacePathCandidate ? 1 : undefined);
  const syntaxValid = identity.workspaceArgumentsValid ?? (argumentCount === 1 && candidates.length === 1);
  if (!syntaxValid || argumentCount !== 1 || candidates.length !== 1) return "unknown";
  if (sameLexicalWorkspacePath(candidates[0]!, workspaceRoot)) return "same-candidate";
  return "other-candidate";
}

/** A lexical match is only a reason to fail closed; it never verifies ownership. */
export function hasWorkspacePathCandidate(identity: BridgeProcessIdentity, workspaceRoot: string): boolean {
  const candidates = identity.workspacePathCandidates ?? (identity.workspacePathCandidate ? [identity.workspacePathCandidate] : []);
  return candidates.some((candidate) => sameLexicalWorkspacePath(candidate, workspaceRoot));
}

/** Recognize only the CLI entrypoints this checkout can launch as a Bridge. */
export function identifyBridgeProcess(record: ProcessRecord): BridgeProcessIdentity {
  const argv = record.argv;
  if (!argv?.length) {
    return { related: Boolean(record.executable && /^node(?:\.exe)?$/i.test(path.basename(record.executable))), verified: false };
  }
  const entryPattern = /(?:^|\/)(?:dist\/cli\/index\.js|bin\/c2c\.js|src\/cli\/index\.ts)$/;
  const isEntry = (value: string): boolean => entryPattern.test(value.replace(/\\/g, "/"));
  let entryIndex = 1;
  if (argv[entryIndex] === "--import" && ["tsx", "tsx/esm"].includes(argv[entryIndex + 1] ?? "")) entryIndex += 2;
  const invocationIndex = argv.findIndex((argument, position) => isEntry(argument) && argv[position + 1] === "serve");
  if (invocationIndex < 0) return { related: false, verified: false };
  const workspaceArguments: string[] = [];
  let workspaceArgumentCount = 0;
  let workspaceArgumentsValid = true;
  for (let index = invocationIndex + 2; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--workspace") {
      workspaceArgumentCount++;
      const value = argv[index + 1];
      if (!value || value.trim().length === 0 || value.startsWith("--")) {
        workspaceArgumentsValid = false;
      } else {
        workspaceArguments.push(value);
        index++;
      }
    } else if (argument.startsWith("--workspace=")) {
      workspaceArgumentCount++;
      const value = argument.slice("--workspace=".length);
      if (value.trim().length === 0) workspaceArgumentsValid = false;
      else workspaceArguments.push(value);
    }
  }
  if (workspaceArgumentCount !== 1 || workspaceArguments.length !== 1) workspaceArgumentsValid = false;
  const workspacePathCandidates = workspaceArguments.flatMap((argument) => {
    const candidate = lexicalWorkspacePath(argument, record.cwd);
    return candidate ? [candidate] : [];
  });
  const workspacePathCandidate = workspaceArgumentsValid && workspaceArgumentCount === 1
    ? workspacePathCandidates[0]
    : undefined;
  const result = (verified = false, workspaceRoot?: string): BridgeProcessIdentity => ({ related: true, verified,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(workspacePathCandidate ? { workspacePathCandidate } : {}),
    ...(workspacePathCandidates.length ? { workspacePathCandidates } : {}),
    workspaceArgumentCount,
    workspaceArgumentsValid,
  });
  if (invocationIndex !== entryIndex) return result();
  const entry = argv[entryIndex];
  if (!entry || !isEntry(entry) || argv[entryIndex + 1] !== "serve") return { related: false, verified: false };
  try {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !record.startId || !record.executable ||
      !/^node(?:\.exe)?$/i.test(path.basename(record.executable))) return result();
    if (!trustedEntries.some((candidate) => fs.existsSync(candidate) && sameBridgePath(canonical(entry, record.cwd), fs.realpathSync.native(candidate)))) {
      return result();
    }
    let workspaceArgument: string | undefined;
    let portSeen = false;
    for (let index = entryIndex + 2; index < argv.length; index++) {
      const argument = argv[index]!;
      if (argument === "--workspace" || argument.startsWith("--workspace=")) {
        if (workspaceArgument !== undefined) return result();
        workspaceArgument = argument === "--workspace" ? argv[++index] : argument.slice("--workspace=".length);
        if (!workspaceArgument) return result();
      } else if (argument === "--port" || argument.startsWith("--port=")) {
        const port = argument === "--port" ? argv[++index] : argument.slice("--port=".length);
        if (portSeen || !/^\d+$/.test(port ?? "") || Number(port) > 65535) return result();
        portSeen = true;
      } else {
        return result();
      }
    }
    if (!workspaceArgument) return result();
    let workspaceRoot: string | undefined;
    try { workspaceRoot = new Workspace(canonical(workspaceArgument, record.cwd)).root; }
    catch { /* The lexical candidate remains useful only to prove another workspace. */ }
    return result(Boolean(workspaceRoot), workspaceRoot);
  } catch {
    return result();
  }
}

export interface VerifiedBridgeProcess {
  record: ProcessRecord;
  workspaceRoot: string;
  port: number;
  instanceId: string;
}

export async function discoverWorkspaceBridgeProcesses(
  snapshot: ProcessSnapshot,
  workspaceRoot: string,
  options: { assumedPort?: number; candidatePorts?: number[]; runtimePid?: number; excludePids?: number[];
    probe?: (port: number) => Promise<HealthPayload | null> } = {}
): Promise<{ bridges: VerifiedBridgeProcess[]; blockers: string[] }> {
  const workspace = new Workspace(workspaceRoot);
  const probe = options.probe ?? probeBridge;
  const listenerOwners = snapshot.listenerOwners ?? (options.assumedPort === undefined
    ? []
    : snapshot.listeners.map((pid) => ({ pid, port: options.assumedPort! })));
  const bridges: VerifiedBridgeProcess[] = [];
  const blockers: string[] = [];
  const excluded = new Set(options.excludePids ?? []);
  for (const record of snapshot.processes) {
    if (excluded.has(record.pid)) continue;
    const identity = identifyBridgeProcess(record);
    if (!identity.related) continue;
    const relation = bridgeWorkspaceRelation(identity, workspace.root);
    const targetsWorkspace = relation === "same-canonical";
    const ownsListener = listenerOwners.some((listener) => listener.pid === record.pid);
    if (relation === "other-canonical" || relation === "other-candidate") continue;
    if (!identity.verified) {
      const relevantPorts = new Set([...(options.candidatePorts ?? []), ...(options.assumedPort !== undefined ? [options.assumedPort] : [])]);
      const ownsRelevantListener = listenerOwners.some((listener) => listener.pid === record.pid && relevantPorts.has(listener.port));
      if (targetsWorkspace || relation === "same-candidate" || hasWorkspacePathCandidate(identity, workspace.root) ||
        options.runtimePid === record.pid || ownsRelevantListener) {
        blockers.push(`PID ${record.pid}: Bridge identity cannot be verified.`);
      }
      continue;
    }
    if (!targetsWorkspace) continue;
    if (!record.startId || !record.executable || !record.argv?.length || !Number.isSafeInteger(record.parentPid) || record.parentPid < 0) {
      blockers.push(`PID ${record.pid}: Bridge birth or parent identity is unavailable.`);
      continue;
    }
    const ports = [...new Set(listenerOwners.filter((listener) => listener.pid === record.pid).map((listener) => listener.port))];
    if (ports.length !== 1) {
      blockers.push(`PID ${record.pid}: expected exactly one owned Bridge listener; found ${ports.length}.`);
      continue;
    }
    const health = await probe(ports[0]!);
    if (!health || health.service !== SERVICE_NAME || health.workspaceId !== workspace.id || health.status !== "ok" ||
      typeof health.instanceId !== "string" || health.instanceId.length === 0) {
      blockers.push(`PID ${record.pid}: owned listener did not prove this workspace's Bridge identity.`);
      continue;
    }
    bridges.push({ record, workspaceRoot: identity.workspaceRoot!, port: ports[0]!, instanceId: health.instanceId });
  }
  return { bridges, blockers };
}

export function processBornAfterParent(child: ProcessRecord, parent: ProcessRecord): boolean {
  const parse = (identity: string | null): bigint | null => {
    if (!identity) return null;
    if (/^linux:\d+$/.test(identity)) return BigInt(identity.slice(6));
    if (/^darwin:\d+:\d+$/.test(identity)) {
      const [, seconds, microseconds] = identity.split(":");
      return BigInt(seconds!) * 1_000_000n + BigInt(microseconds!);
    }
    return null;
  };
  if (child.startId?.startsWith("windows:") && parent.startId?.startsWith("windows:")) {
    const childTime = child.startId.slice("windows:".length);
    const parentTime = parent.startId.slice("windows:".length);
    return !Number.isNaN(Date.parse(childTime)) && !Number.isNaN(Date.parse(parentTime)) && childTime >= parentTime;
  }
  const childTime = parse(child.startId), parentTime = parse(parent.startId);
  return childTime !== null && parentTime !== null && childTime >= parentTime;
}

export function processRecordFingerprint(record: ProcessRecord): string {
  return JSON.stringify([record.pid, record.parentPid, record.startId, record.executable, record.argv, record.cwd]);
}

export function descendantProcessTree(
  snapshot: ProcessSnapshot,
  roots: ProcessRecord[]
): { records: ProcessRecord[]; blockers: string[] } {
  const blockers: string[] = [];
  const byPid = new Map(snapshot.processes.map((record) => [record.pid, record]));
  const selected = new Set<number>();
  for (const root of roots) {
    const current = byPid.get(root.pid);
    if (!current || processRecordFingerprint(current) !== processRecordFingerprint(root) || !root.startId || !root.executable || !root.argv?.length) {
      blockers.push(`PID ${root.pid}: root process identity is missing or changed.`);
      continue;
    }
    selected.add(root.pid);
  }

  for (let changed = true; changed;) {
    changed = false;
    for (const record of snapshot.processes) {
      if (selected.has(record.pid) || !selected.has(record.parentPid)) continue;
      const parent = byPid.get(record.parentPid)!;
      if (!record.startId || !record.executable || !record.argv?.length || record.pid === record.parentPid || !processBornAfterParent(record, parent)) {
        blockers.push(`PID ${record.pid}: descendant identity or parent birth order cannot be verified.`);
        continue;
      }
      selected.add(record.pid);
      changed = true;
    }
  }

  const selectedRecords = snapshot.processes.filter((record) => selected.has(record.pid));
  const depth = new Map<number, number>();
  const getDepth = (record: ProcessRecord, visiting = new Set<number>()): number => {
    if (depth.has(record.pid)) return depth.get(record.pid)!;
    if (visiting.has(record.pid)) {
      blockers.push("Process parentage is cyclic; refusing retirement.");
      return 0;
    }
    visiting.add(record.pid);
    const parent = byPid.get(record.parentPid);
    const value = parent && selected.has(parent.pid) ? getDepth(parent, visiting) + 1 : 0;
    depth.set(record.pid, value);
    return value;
  };
  for (const record of selectedRecords) getDepth(record);
  selectedRecords.sort((a, b) => (depth.get(b.pid) ?? 0) - (depth.get(a.pid) ?? 0));
  return { records: selectedRecords, blockers };
}
