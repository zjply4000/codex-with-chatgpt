import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { findBridgeObservation, runtimeFile, type BridgeObservation, type RuntimeState } from "../bridge/runtime.js";
import { verifyBridgeConnection, type BridgeAdminInfo } from "../bridge/verify.js";
import { connectorAction, connectorNameFor, endpointFile, mcpUrlFromPublic, normalizePublicUrl, readLastEndpoint, writeLastEndpoint, reclaimUserMessage } from "../config/endpoint.js";
import { isNamedTunnelReady, readTunnelState, tunnelStateFile } from "../tunnel/state.js";
import { normalizeNamedTunnelHostname } from "../tunnel/cloudflared-named.js";
import { tunnelStartRequestTimeoutMs } from "../tunnel/timeouts.js";
import { adminFetch, BridgeAdminUnavailableError, ensureBridge, type EnsureBridgeResult } from "./daemon.js";
import { createProcessInspector, type ProcessInspector, type ProcessRecord, type ProcessSnapshot } from "./inspect.js";
import { acquireMaintenance } from "./maintenance.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entries = ["dist/cli/index.js", "bin/c2c.js", "src/cli/index.ts"].map(file => path.join(checkout, file));
const PHASES = ["plan", "retire", "clear-runtime", "start", "restore-tunnel", "verify"] as const;
type Phase = typeof PHASES[number];
type Verification = Awaited<ReturnType<typeof verifyBridgeConnection>>;

export interface RecoveryDependencies {
  inspector: ProcessInspector;
  observe(workspaceId: string): Promise<BridgeObservation>;
  info(runtime: RuntimeState): Promise<BridgeAdminInfo>;
  start(root: string, recoveryToken: string): Promise<EnsureBridgeResult>;
  startTunnel(runtime: RuntimeState, recoveryToken: string): Promise<string>;
  verify(workspaceId: string, runtime: RuntimeState, publicUrl: string | null): Promise<Verification>;
  portFree(port: number): Promise<boolean>;
  pause(ms: number): Promise<void>;
  now(): number;
}

interface PublicPlan {
  workspace: string;
  observation: { state: string; reason?: string };
  runtime: { pid: number; port: number } | null;
  bridges: { pid: number; executable: string; summary: string; descendants: number }[];
  descendantCount: number;
  tunnel: { mode: "local" | "named" | "quick"; hostname: string | null; restore: boolean };
  phases: readonly string[];
  blockers: string[];
}

export interface RecoveryResult {
  ok: boolean;
  workspaceId: string;
  dryRun: boolean;
  canRecover: boolean;
  recovered: boolean;
  previousState: string;
  phase: Phase;
  message?: string;
  plan: PublicPlan;
  retired: { bridges: number; descendants: number };
  runtimeCleared: boolean;
  bridge?: { state: string; pid: number; instanceId?: string };
  tunnel?: { mode: string; hostname: string | null; restored: boolean };
  connectorRepairNeeded: boolean;
  chatgptRepair?: { needed: boolean; connectorAction: string; connectorName: string; userMessage?: string; mcpUrl: string | null };
  verification?: Verification;
  error?: string;
}

interface InternalPlan {
  public: PublicPlan;
  runtime: RuntimeState | null;
  termination: ProcessRecord[];
  roots: ProcessRecord[];
  files: Map<string, string | null>;
  healthy: boolean;
}

function bytes(file: string): string | null {
  try { return fs.readFileSync(file).toString("base64"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function canonical(input: string, cwd: string | null): string {
  if (!path.isAbsolute(input) && !cwd) throw new Error("relative path without process cwd");
  return fs.realpathSync.native(path.resolve(cwd ?? "", input));
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform !== "win32" && process.platform !== "darwin") return false;
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  // Case aliases must also name the same object; hard links in another checkout do not qualify.
  const left = fs.statSync(a), right = fs.statSync(b);
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

/** Recognize the actual daemon argv grammar, never workspace-name substrings. */
function identify(record: ProcessRecord): { related: boolean; root?: string; valid: boolean } {
  const argv = record.argv;
  if (!argv?.length) return { related: Boolean(record.executable && /^node(?:\.exe)?$/i.test(path.basename(record.executable))), valid: false };
  let index = 1;
  if (argv[index] === "--import" && ["tsx", "tsx/esm"].includes(argv[index + 1])) index += 2;
  const isEntry = (value: string) => /(?:^|\/)(?:dist\/cli\/index\.js|bin\/c2c\.js|src\/cli\/index\.ts)$/.test(value.replace(/\\/g, "/"));
  const invocation = argv.findIndex((arg, position) => isEntry(arg) && argv[position + 1] === "serve");
  if (invocation >= 0 && invocation !== index) return { related: true, valid: false };
  const entry = argv[index];
  const related = Boolean(entry && isEntry(entry));
  if (!related || argv[index + 1] !== "serve") return { related: false, valid: false };
  try {
    if (!record.executable || !/^node(?:\.exe)?$/i.test(path.basename(record.executable))) return { related: true, valid: false };
    if (!entries.some(candidate => fs.existsSync(candidate) && samePath(canonical(entry, record.cwd), fs.realpathSync.native(candidate)))) {
      return { related: true, valid: false };
    }
    let workspace: string | undefined;
    let portSeen = false;
    for (let i = index + 2; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--workspace" || arg.startsWith("--workspace=")) {
        if (workspace !== undefined) return { related: true, valid: false };
        workspace = arg === "--workspace" ? argv[++i] : arg.slice("--workspace=".length);
        if (!workspace) return { related: true, valid: false };
      } else if (arg === "--port" || arg.startsWith("--port=")) {
        const value = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
        if (portSeen || !/^\d+$/.test(value) || Number(value) > 65535) return { related: true, valid: false };
        portSeen = true;
      } else return { related: true, valid: false };
    }
    if (!workspace) return { related: true, valid: false };
    return { related: true, valid: true, root: new Workspace(canonical(workspace, record.cwd)).root };
  } catch { return { related: true, valid: false }; }
}

function fingerprint(record: ProcessRecord): string {
  return JSON.stringify([record.pid, record.parentPid, record.startId, record.executable, record.argv, record.cwd]);
}

function bornAfterParent(child: ProcessRecord, parent: ProcessRecord): boolean {
  const parse = (id: string | null): bigint | null => {
    if (!id) return null;
    if (/^linux:\d+$/.test(id)) return BigInt(id.slice(6));
    if (/^darwin:\d+:\d+$/.test(id)) { const [, seconds, microseconds] = id.split(":"); return BigInt(seconds) * 1_000_000n + BigInt(microseconds); }
    return null;
  };
  if (child.startId?.startsWith("windows:") && parent.startId?.startsWith("windows:")) {
    const a = child.startId.slice(8), b = parent.startId.slice(8);
    return !Number.isNaN(Date.parse(a)) && !Number.isNaN(Date.parse(b)) && a >= b;
  }
  const a = parse(child.startId), b = parse(parent.startId);
  return a !== null && b !== null && a >= b;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (free: boolean) => { socket.destroy(); resolve(free); };
    socket.once("connect", () => finish(false));
    socket.once("error", error => finish((error as NodeJS.ErrnoException).code === "ECONNREFUSED"));
    socket.setTimeout(1000, () => finish(false));
  });
}

function defaults(): RecoveryDependencies {
  return { inspector: createProcessInspector(), observe: findBridgeObservation,
    info: runtime => adminFetch(runtime, "GET", "/admin/info"),
    start: (root, token) => ensureBridge(root, { recoveryToken: token }),
    startTunnel: async (runtime, token) => {
      const info = await adminFetch<BridgeAdminInfo>(runtime, "GET", "/admin/info");
      const result = await adminFetch<{ url?: string }>(runtime, "POST", "/admin/tunnel/start", tunnelStartRequestTimeoutMs(info.tunnel.startTimeoutMs), token);
      if (!result.url) throw new Error("tunnel start did not return a URL");
      return result.url;
    }, verify: verifyBridgeConnection, portFree: portIsFree,
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now };
}

async function buildPlan(ws: Workspace, deps: RecoveryDependencies): Promise<InternalPlan> {
  const observation = await deps.observe(ws.id);
  const runtime = observation.runtime;
  const tunnel = readTunnelState(ws.id), endpoint = readLastEndpoint(ws.id);
  const hadPublic = Boolean(endpoint?.publicUrl || runtime?.publicUrl);
  let configuredHostname: string | null = null;
  try { if (tunnel.hostname) configuredHostname = normalizeNamedTunnelHostname(tunnel.hostname); }
  catch { /* Invalid binding is a blocker for recovery, not an authority to stop a healthy Bridge. */ }
  const publicPlan: PublicPlan = { workspace: ws.root, observation: { state: observation.state,
    reason: observation.state === "healthy" ? undefined : observation.reason }, runtime: runtime ? { pid: runtime.pid, port: runtime.port } : null,
    bridges: [], descendantCount: 0, tunnel: { mode: !hadPublic ? "local" : tunnel.preference === "named" ? "named" : "quick",
      hostname: configuredHostname, restore: hadPublic }, phases: PHASES, blockers: [] };
  const result: InternalPlan = { public: publicPlan, runtime, termination: [], roots: [], files: new Map(), healthy: false };
  if (observation.state === "healthy") {
    try { await deps.info(observation.runtime); result.healthy = true; return result; }
    catch (error) {
      if (!(error instanceof BridgeAdminUnavailableError)) {
        publicPlan.blockers.push("Bridge admin status cannot establish a safe recovery reason."); return result;
      }
      publicPlan.observation = { state: "unknown", reason: error.reason };
    }
  } else if (observation.state !== "unknown" || observation.reason !== "stale_runtime") {
    publicPlan.blockers.push("Recovery only handles stale_runtime or proven admin_unavailable; this observation is ambiguous or stopped."); return result;
  }
  if (!runtime || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) {
    publicPlan.blockers.push("No usable workspace runtime record."); return result;
  }
  try {
    if (runtime.workspaceId !== ws.id || !samePath(new Workspace(runtime.workspaceRoot).root, ws.root)) throw new Error("wrong binding");
  } catch { publicPlan.blockers.push("Saved runtime workspace binding cannot be verified."); return result; }
  for (const file of [runtimeFile(ws.id), endpointFile(ws.id), tunnelStateFile(ws.id)]) result.files.set(file, bytes(file));
  if (hadPublic && tunnel.preference === "named") {
    if (!isNamedTunnelReady(tunnel)) { publicPlan.blockers.push("Existing Named Tunnel binding is incomplete; recovery will not provision or log in."); return result; }
    const hostname = normalizeNamedTunnelHostname(tunnel.hostname!);
    publicPlan.tunnel = { mode: "named", hostname, restore: true };
    if (normalizePublicUrl(endpoint?.publicUrl ?? runtime.publicUrl!) !== `https://${hostname}`) {
      publicPlan.blockers.push("Named hostname differs from the saved public endpoint."); return result;
    }
  } else if (hadPublic) publicPlan.tunnel = { mode: "quick", hostname: null, restore: true };

  let snapshot: ProcessSnapshot;
  try { snapshot = await deps.inspector.snapshot(runtime.port); }
  catch { publicPlan.blockers.push("OS process or listener inspection is unavailable; manual maintenance is required."); return result; }
  const marked = new Set([...snapshot.listeners, runtime.pid]);
  for (const record of snapshot.processes) {
    const identity = identify(record);
    if (identity.valid && identity.root && samePath(identity.root, ws.root)) {
      if (!record.startId || !record.executable || record.pid === process.pid) publicPlan.blockers.push(`PID ${record.pid}: process birth identity cannot be safely established.`);
      else result.roots.push(record);
    } else if (marked.has(record.pid) || (identity.related && !identity.valid)) {
      publicPlan.blockers.push(`PID ${record.pid}: C2C serve and exact workspace ownership could not be verified.`);
    }
  }
  const roots = new Set(result.roots.map(record => record.pid));
  for (const listener of snapshot.listeners) if (!roots.has(listener)) publicPlan.blockers.push(`Listener PID ${listener} is not a verified target Bridge.`);
  if (!roots.size) publicPlan.blockers.push("No strictly verified Bridge process for this workspace.");
  const selected = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const record of snapshot.processes) if (!selected.has(record.pid) && selected.has(record.parentPid)) {
      selected.add(record.pid); changed = true;
    }
  }
  result.termination = snapshot.processes.filter(record => selected.has(record.pid));
  const records = new Map(result.termination.map(record => [record.pid, record]));
  const depth = new Map<number, number>();
  const findDepth = (record: ProcessRecord, visited = new Set<number>()): number => {
    if (depth.has(record.pid)) return depth.get(record.pid)!;
    if (visited.has(record.pid)) { publicPlan.blockers.push("Process parentage is cyclic or unreliable."); return 0; }
    visited.add(record.pid);
    const parent = records.get(record.parentPid);
    if (parent && !bornAfterParent(record, parent)) publicPlan.blockers.push(`PID ${record.pid}: parent PID may have been reused.`);
    const value = parent ? findDepth(parent, visited) + 1 : 0;
    depth.set(record.pid, value); return value;
  };
  for (const record of result.termination) findDepth(record);
  for (const record of result.termination) {
    const identity = identify(record);
    if (!record.startId || !record.executable || !record.argv?.length || record.pid === process.pid || record.parentPid === record.pid ||
      (identity.valid && identity.root && !samePath(identity.root, ws.root))) {
      publicPlan.blockers.push(`PID ${record.pid}: descendant identity or target parentage could not be safely established.`);
    }
  }
  result.termination.sort((a, b) => (depth.get(b.pid) ?? 0) - (depth.get(a.pid) ?? 0));
  publicPlan.descendantCount = result.termination.filter(record => !roots.has(record.pid)).length;
  const descendsFrom = (child: ProcessRecord, rootPid: number): boolean => {
    const visited = new Set<number>();
    for (let parent = child.parentPid; records.has(parent) && !visited.has(parent); parent = records.get(parent)!.parentPid) {
      if (parent === rootPid) return true;
      visited.add(parent);
    }
    return false;
  };
  publicPlan.bridges = result.roots.map(record => ({ pid: record.pid, executable: record.executable!,
    summary: `C2C serve --workspace ${ws.root}`, descendants: result.termination.filter(child => !roots.has(child.pid) && descendsFrom(child, record.pid)).length }));
  return result;
}

function unchangedFiles(plan: InternalPlan, allowMissingRuntime = false): boolean {
  return [...plan.files].every(([file, before]) => (allowMissingRuntime && file === runtimeFile(plan.runtime!.workspaceId) && bytes(file) === null) || bytes(file) === before);
}

export async function recoverBridge(root: string, opts: { dryRun?: boolean } = {}, injected: Partial<RecoveryDependencies> = {}): Promise<RecoveryResult> {
  const ws = new Workspace(root), deps = { ...defaults(), ...injected };
  const internal = await buildPlan(ws, deps), plan = internal.public;
  const result: RecoveryResult = { ok: false, workspaceId: ws.id, dryRun: Boolean(opts.dryRun), canRecover: false,
    recovered: false, previousState: plan.observation.reason ?? plan.observation.state, phase: "plan", plan,
    retired: { bridges: 0, descendants: 0 }, runtimeCleared: false, connectorRepairNeeded: false };
  if (internal.healthy) return { ...result, ok: true, message: "Bridge is healthy; recovery is not needed." };
  if (plan.blockers.length) return { ...result, error: "Cannot safely recover: " + plan.blockers.join(" ") };
  result.canRecover = true;
  if (opts.dryRun) return { ...result, ok: true };
  let lock: ReturnType<typeof acquireMaintenance> | undefined;
  try {
    lock = acquireMaintenance(ws.id);
    const fresh = await buildPlan(ws, deps);
    if (fresh.healthy || fresh.public.blockers.length || !unchangedFiles(internal) ||
      JSON.stringify(fresh.termination.map(fingerprint)) !== JSON.stringify(internal.termination.map(fingerprint))) {
      throw new Error("Plan changed before retirement");
    }
    result.phase = "retire";
    for (const record of internal.termination) await deps.inspector.terminate(record);
    const deadline = deps.now() + 10_000;
    while (true) {
      const snapshot = await deps.inspector.snapshot(internal.runtime!.port);
      const survivors = snapshot.processes.filter(record => internal.termination.some(old => old.pid === record.pid && old.startId === record.startId));
      const newCandidates = snapshot.processes.some(record => { const identity = identify(record); return identity.related && (!identity.valid || (identity.root && samePath(identity.root, ws.root))); });
      if (!survivors.length && !newCandidates && !snapshot.listeners.length && await deps.portFree(internal.runtime!.port)) break;
      if (deps.now() >= deadline) throw new Error("Verified processes or old listener did not retire");
      await deps.pause(200);
    }
    result.retired = { bridges: internal.roots.length, descendants: plan.descendantCount };
    result.phase = "clear-runtime";
    if (!unchangedFiles(internal, true)) throw new Error("Saved state changed during retirement");
    fs.rmSync(runtimeFile(ws.id), { force: true });
    result.runtimeCleared = true;
    result.phase = "start";
    const { runtime } = await deps.start(ws.root, lock.token);
    result.bridge = { state: "healthy", pid: runtime.pid, instanceId: runtime.instanceId };
    result.tunnel = { mode: plan.tunnel.mode, hostname: plan.tunnel.hostname, restored: false };
    let url: string | null = null;
    const previous = readLastEndpoint(ws.id);
    if (plan.tunnel.restore) {
      result.phase = "restore-tunnel";
      url = await deps.startTunnel(runtime, lock.token);
      if (plan.tunnel.mode === "named" && normalizePublicUrl(url) !== `https://${plan.tunnel.hostname}`) throw new Error("Named hostname changed");
      const mcpUrl = mcpUrlFromPublic(url)!;
      const action = connectorAction(previous?.mcpUrl, mcpUrl);
      const name = connectorNameFor({ workspaceName: ws.name, workspaceId: ws.id,
        previousName: previous?.connectorName, hadEndpointBefore: Boolean(previous) });
      result.connectorRepairNeeded = action === "update";
      result.chatgptRepair = { needed: action === "update", connectorAction: action, connectorName: name,
        userMessage: action === "update" ? reclaimUserMessage(name) : undefined, mcpUrl };
      result.tunnel!.restored = true;
    }
    result.phase = "verify";
    result.verification = await deps.verify(ws.id, runtime, url);
    result.bridge.state = result.verification.report.bridge?.ok ? "healthy" : "unknown";
    if (!result.verification.ok) {
      result.error = "Recovered Bridge did not pass connection verification; it was not restarted again.";
      return result;
    }
    if (url) {
      const mcpUrl = mcpUrlFromPublic(url)!;
      writeLastEndpoint({ workspaceId: ws.id, port: runtime.port, publicUrl: url, mcpUrl, connectorName: result.chatgptRepair!.connectorName });
    }
    result.ok = true; result.recovered = true;
    return result;
  } catch {
    result.error = `Recovery stopped during ${result.phase}; no further processes, runtime records or connectors will be changed.`;
    try {
      const current = await deps.observe(ws.id);
      if (current.runtime) result.bridge = { state: current.state, pid: current.runtime.pid, instanceId: current.runtime.instanceId };
    } catch { /* Preserve the last known diagnostic if observation also fails. */ }
    return result;
  } finally {
    try { lock?.release(); }
    catch { result.ok = false; result.error = "Recovery finished its current phase but the maintenance lock could not be released; manual maintenance is required."; }
  }
}
