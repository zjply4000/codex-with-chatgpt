import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, ensureDir, getStateDir } from "../config/paths.js";
import { clearRuntimeState, findBridgeObservation, matchesBridgeInstance, probeBridge, readRuntimeState, type BridgeObservation, type HealthPayload, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { createProcessInspector, type ProcessInspector, type ProcessRecord } from "./inspect.js";
import { descendantProcessTree, discoverWorkspaceBridgeProcesses, identifyBridgeProcess, sameBridgePath,
  type VerifiedBridgeProcess } from "./bridge-process.js";
import { retireVerifiedBridgeTree } from "./retirement.js";
import { acquireMaintenance, assertMaintenanceAccess } from "./maintenance.js";
import { readLastEndpoint } from "../config/endpoint.js";
import { readTunnelState } from "../tunnel/state.js";
import { tunnelStartRequestTimeoutMs } from "../tunnel/timeouts.js";
import { SERVICE_NAME } from "../version.js";

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

export interface EnsureBridgeDependencies {
  inspector: ProcessInspector;
  observe(workspaceId: string): Promise<BridgeObservation>;
  probe(port: number): Promise<HealthPayload | null>;
  spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
  pause(ms: number): Promise<void>;
  startupTimeoutMs?: number;
}

async function retireSpawnedBridgeChild(
  deps: EnsureBridgeDependencies,
  workspaceRoot: string,
  childPid: number,
  command: string,
  args: string[],
  timeoutMs = 10_000
): Promise<void> {
  const pause = deps.pause;
  const deadline = Date.now() + timeoutMs;
  let root: ProcessRecord | undefined;
  let treeRecords: ProcessRecord[] = [];
  while (Date.now() < deadline) {
    const snapshot = await deps.inspector.snapshot(DEFAULT_PORT);
    const found = snapshot.processes.find((record) => record.pid === childPid);
    if (!found) {
      try { process.kill(childPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      await pause(50);
      continue;
    }
    const identity = identifyBridgeProcess(found);
    const expectedArgs = args;
    if (identity.verified && identity.workspaceRoot && sameBridgePath(identity.workspaceRoot, workspaceRoot) &&
      found.pid === childPid && found.parentPid === process.pid && found.executable &&
      sameBridgePath(found.executable, command) && found.startId && found.argv?.length === expectedArgs.length + 1 &&
      found.argv.slice(1).every((argument, index) => argument === expectedArgs[index])) {
      root = found;
      const tree = descendantProcessTree(snapshot, [found]);
      if (tree.blockers.length) throw new Error(`POST_SPAWN_CLEANUP_UNVERIFIED: ${tree.blockers.join(" ")}`);
      treeRecords = tree.records;
      break;
    }
    throw new Error(`POST_SPAWN_CLEANUP_UNVERIFIED: PID ${childPid} no longer matches the spawned Bridge identity.`);
  }
  if (!root || !treeRecords.length) {
    try { process.kill(childPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    throw new Error(`POST_SPAWN_CLEANUP_UNVERIFIED: could not rediscover exact PID ${childPid}.`);
  }

  const oldIdentities = new Map(treeRecords.map((record) => [record.pid, record.startId]));
  for (const record of treeRecords) await deps.inspector.terminate(record);
  while (Date.now() < deadline) {
    const snapshot = await deps.inspector.snapshot(DEFAULT_PORT);
    const survivors = snapshot.processes.filter((record) => oldIdentities.get(record.pid) === record.startId);
    const survivorPids = new Set(survivors.map((record) => record.pid));
    const listenersRemain = (snapshot.listenerOwners ?? [])
      .some((listener) => survivorPids.has(listener.pid));
    if (survivors.length === 0 && !listenersRemain) return;
    await pause(100);
  }
  throw new Error(`POST_SPAWN_CLEANUP_TIMEOUT: exact child PID ${childPid} or its listener remains active.`);
}

export interface BridgeLifecycleResult {
  runtime: RuntimeState | null;
  stopped: boolean;
  publicUrl: string | null;
  tunnelRestored: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(
  workspaceRoot: string,
  opts: { port?: number; recoveryToken?: string } = {},
  injected: Partial<EnsureBridgeDependencies> = {}
): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  assertMaintenanceAccess(workspace.id, opts.recoveryToken);
  const deps = ensureDependencies(injected);
  let maintenance: ReturnType<typeof acquireMaintenance> | undefined;
  if (!opts.recoveryToken) {
    try { maintenance = acquireMaintenance(workspace.id); }
    catch { throw new Error("Bridge maintenance is in progress; refusing concurrent start."); }
  }
  const maintenanceToken = opts.recoveryToken ?? maintenance!.token;
  const scan = async (runtimePid?: number, pendingChildPid?: number) => {
    const snapshot = await deps.inspector.snapshot(opts.port ?? DEFAULT_PORT);
    const excludePids: number[] = [];
    if (pendingChildPid !== undefined) {
      const pending = snapshot.processes.find((record) => record.pid === pendingChildPid);
      const identity = pending ? identifyBridgeProcess(pending) : null;
      const ownedListeners = (snapshot.listenerOwners ?? snapshot.listeners.map((pid) => ({ pid, port: opts.port ?? DEFAULT_PORT })))
        .filter((listener) => listener.pid === pendingChildPid);
      if (pending && pending.parentPid === process.pid && identity?.verified && identity.workspaceRoot &&
        sameBridgePath(identity.workspaceRoot, workspace.root)) {
        let ready = false;
        if (ownedListeners.length === 1) {
          const health = await deps.probe(ownedListeners[0]!.port);
          ready = Boolean(health && health.service === SERVICE_NAME && health.workspaceId === workspace.id &&
            health.status === "ok" && typeof health.instanceId === "string" && health.instanceId.length > 0);
        }
        if (!ready) excludePids.push(pendingChildPid);
      }
    }
    const discovery = await discoverWorkspaceBridgeProcesses(snapshot, workspace.root, {
      assumedPort: opts.port ?? DEFAULT_PORT,
      runtimePid,
      excludePids,
      probe: deps.probe,
    });
    if (discovery.blockers.length) {
      throw new Error(`BRIDGE_IDENTITY_UNVERIFIED: ${discovery.blockers.join(" ")}`);
    }
    return discovery.bridges;
  };

  try {
    const observation = await deps.observe(workspace.id);
    assertMaintenanceAccess(workspace.id, maintenanceToken);
    if (observation.state === "unknown") {
      throw new Error(`Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`);
    }
    const bridges = await scan(observation.runtime?.pid);
    if (bridges.length > 1) {
      throw new Error("DUPLICATE_BRIDGE: Multiple verified Bridge processes exist for this workspace.");
    }
    if (bridges.length === 1) {
      const bridge = bridges[0]!;
      if (observation.state === "healthy" && observation.runtime.pid === bridge.record.pid &&
        observation.runtime.port === bridge.port && observation.runtime.instanceId === bridge.instanceId) {
        return { runtime: observation.runtime, spawned: false };
      }
      throw new Error("DUPLICATE_BRIDGE: A verified Bridge already exists but does not match the saved runtime; refusing to start another.");
    }
    if (observation.state === "healthy") {
      // startBridge() is also used embedded in tests and by library consumers.
      // Preserve that in-process reuse only when there is no other verified daemon.
      if (observation.runtime.pid === process.pid) return { runtime: observation.runtime, spawned: false };
      throw new Error("BRIDGE_IDENTITY_UNVERIFIED: The healthy runtime PID is not a verified workspace Bridge process.");
    }
    const logDir = ensureDir(path.join(getStateDir(), "logs"));
    const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
    const out = fs.openSync(logFile, "a", 0o600);
    try {
      fs.chmodSync(logFile, 0o600);
    } catch {
      // Windows / filesystems without chmod semantics
    }
    const { cmd, args } = cliEntry();
    const spawnArgs = [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])];
    let child: ChildProcess;
    try {
      child = deps.spawnProcess(
        cmd,
        spawnArgs,
        { detached: true, stdio: ["ignore", out, out], env: { ...process.env, C2C_BRIDGE_MAINTENANCE_TOKEN: maintenanceToken }, windowsHide: true }
      );
    } finally {
      fs.closeSync(out);
    }
    child.unref();

    try {
      const deadline = Date.now() + (deps.startupTimeoutMs ?? 20_000);
      while (Date.now() < deadline) {
        await deps.pause(300);
        assertMaintenanceAccess(workspace.id, maintenanceToken);
        const currentObservation = await deps.observe(workspace.id);
        const runtime = currentObservation.state === "healthy" ? currentObservation.runtime : null;
        const currentBridges = await scan(currentObservation.runtime?.pid,
          child.exitCode === null && child.pid ? child.pid : undefined);
        if (currentBridges.length > 1) {
          throw new Error("DUPLICATE_BRIDGE: Multiple verified Bridge processes appeared during startup.");
        }
        if (runtime && currentBridges.length === 1 && runtime.pid === child.pid &&
          currentBridges[0]!.record.pid === runtime.pid && currentBridges[0]!.port === runtime.port &&
          currentBridges[0]!.instanceId === runtime.instanceId) return { runtime, spawned: true };
        if (runtime && currentBridges.length === 0 && runtime.pid === process.pid) return { runtime, spawned: false };
        if (child.exitCode !== null && child.exitCode !== 0) {
          throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
        }
      }
      throw new Error(`Bridge did not become a verified singleton within ${deps.startupTimeoutMs ?? 20_000}ms. See ${logFile}`);
    } catch (error) {
      if (child.pid !== undefined) {
        try {
          await retireSpawnedBridgeChild(deps, workspace.root, child.pid, cmd, spawnArgs);
        } catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`${originalMessage}; ${cleanupMessage}`, { cause: error });
        }
      }
      throw error;
    }
  } finally {
    maintenance?.release();
  }
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
  recoveryToken?: string,
  requestBody?: unknown
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
        headers: {
          Authorization: `Bearer ${runtime.adminToken}`,
          ...(requestBody !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(requestBody !== undefined ? { body: JSON.stringify(requestBody) } : {}),
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

function ensureDependencies(injected: Partial<EnsureBridgeDependencies>): EnsureBridgeDependencies {
  return {
    inspector: injected.inspector ?? createProcessInspector(),
    observe: injected.observe ?? findBridgeObservation,
    probe: injected.probe ?? probeBridge,
    spawnProcess: injected.spawnProcess ?? ((command, args, options) => spawn(command, args, options)),
    pause: injected.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    startupTimeoutMs: injected.startupTimeoutMs,
  };
}

async function retireWorkspaceBridges(
  workspaceRoot: string,
  options: { restart: boolean; tunnel?: boolean },
  injected: Partial<EnsureBridgeDependencies>
): Promise<BridgeLifecycleResult> {
  const workspace = new Workspace(workspaceRoot);
  const deps = ensureDependencies(injected);
  const maintenance = acquireMaintenance(workspace.id);
  try {
    const observation = await deps.observe(workspace.id);
    const restartableUnverifiedRuntime = options.restart && observation.state === "unknown" &&
      (observation.reason === "stale_runtime" || observation.reason === "workspace_mismatch");
    if (observation.state === "unknown" && !restartableUnverifiedRuntime) {
      throw new Error(`Bridge state is uncertain (${observation.reason}); refusing to stop an unverified instance.`);
    }
    const savedRuntime = observation.runtime ?? readRuntimeState(workspace.id);
    const endpoint = readLastEndpoint(workspace.id);
    const wasPublic = Boolean(savedRuntime?.publicUrl || endpoint?.publicUrl);
    const inspectionPort = savedRuntime?.port ?? DEFAULT_PORT;
    const snapshot = await deps.inspector.snapshot(inspectionPort);
    const discovery = await discoverWorkspaceBridgeProcesses(snapshot, workspace.root, {
      assumedPort: inspectionPort,
      runtimePid: savedRuntime?.pid,
      probe: deps.probe,
    });
    if (discovery.blockers.length) {
      throw new Error(`BRIDGE_IDENTITY_UNVERIFIED: ${discovery.blockers.join(" ")}`);
    }
    if (!discovery.bridges.length) {
      if (observation.state === "healthy" && observation.runtime.pid === process.pid) {
        throw new Error("BRIDGE_IDENTITY_UNVERIFIED: refusing to terminate an embedded Bridge hosted by the lifecycle caller.");
      }
      if (observation.state === "healthy" || (observation.state === "unknown" && !restartableUnverifiedRuntime)) {
        throw new Error("BRIDGE_IDENTITY_UNVERIFIED: A live runtime has no verified Bridge process.");
      }
      if (savedRuntime) clearRuntimeState(workspace.id);
      if (!options.restart) return { runtime: null, stopped: false, publicUrl: null, tunnelRestored: false };
    } else {
      const roots = discovery.bridges.map((bridge) => bridge.record);
      await retireVerifiedBridgeTree({ inspector: deps.inspector, workspaceRoot: workspace.root,
        snapshot, roots, assumedPort: inspectionPort, pause: deps.pause });
      clearRuntimeState(workspace.id);
    }

    if (!options.restart) return { runtime: null, stopped: true, publicUrl: null, tunnelRestored: false };
    const { runtime } = await ensureBridge(workspace.root, { recoveryToken: maintenance.token }, injected);
    const restoreTunnel = Boolean(options.tunnel || wasPublic);
    let publicUrl: string | null = null;
    if (restoreTunnel) {
      const info = await adminFetch<{ tunnel: { startTimeoutMs?: number } }>(runtime, "GET", "/admin/info");
      const started = await adminFetch<{ url?: string }>(runtime, "POST", "/admin/tunnel/start",
        tunnelStartRequestTimeoutMs(info.tunnel.startTimeoutMs), maintenance.token);
      if (!started.url) throw new Error("TUNNEL_START_FAILED: restarted Bridge did not return a public URL.");
      publicUrl = started.url;
    }
    return { runtime, stopped: true, publicUrl, tunnelRestored: restoreTunnel };
  } finally {
    maintenance.release();
  }
}

export async function stopBridge(workspaceRoot: string, injected: Partial<EnsureBridgeDependencies> = {}): Promise<boolean> {
  const result = await retireWorkspaceBridges(workspaceRoot, { restart: false }, injected);
  return result.stopped;
}

export async function restartBridge(
  workspaceRoot: string,
  options: { tunnel?: boolean } = {},
  injected: Partial<EnsureBridgeDependencies> = {}
): Promise<BridgeLifecycleResult> {
  return retireWorkspaceBridges(workspaceRoot, { restart: true, tunnel: options.tunnel }, injected);
}
