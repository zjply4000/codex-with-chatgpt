import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverBridge, type RecoveryDependencies } from "../src/process/recover.js";
import { readRuntimeState, runtimeFile, writeRuntimeState, type BridgeObservation } from "../src/bridge/runtime.js";
import { endpointFile, writeLastEndpoint } from "../src/config/endpoint.js";
import { tunnelStateFile, writeTunnelState } from "../src/tunnel/state.js";
import { sessionFile, writeSession } from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import type { ProcessRecord } from "../src/process/inspect.js";
import { adminFetch, BridgeAdminUnavailableError, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { acquireMaintenance } from "../src/process/maintenance.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(checkout, "dist/cli/index.js");
const dirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

function fixture() {
  const root = makeTmpDir("recover-workspace");
  const stateDir = makeTmpDir("recover-state");
  dirs.push(root, stateDir);
  process.env.C2C_STATE_DIR = stateDir;
  const ws = new Workspace(root);
  const runtime = { service: "c2c-bridge", version: "0.1.3", workspaceId: ws.id, workspaceRoot: root,
    pid: 900, port: 12345, adminToken: "never-output-admin", publicUrl: null, startedAt: "old", instanceId: "old" };
  writeRuntimeState(runtime);
  const bridge = (pid: number, workspace = root): ProcessRecord => ({ pid, parentPid: 1,
    executable: process.execPath, argv: [process.execPath, entry, "serve", "--workspace", workspace],
    startId: `linux:${pid}`, cwd: root });
  let processes = [bridge(100)];
  let observation: BridgeObservation = { state: "unknown", reason: "stale_runtime", runtime };
  let clock = 0;
  const events: string[] = [];
  const inspector = { snapshot: vi.fn(async () => ({ processes: structuredClone(processes),
    listeners: processes.some(p => p.pid === 100) ? [100] : [] })),
    terminate: vi.fn(async (record: ProcessRecord) => { events.push(`retire:${record.pid}`); processes = processes.filter(p => p.pid !== record.pid); }) };
  const nextRuntime = { ...runtime, pid: 200, instanceId: "new", adminToken: "new-private" };
  const deps: RecoveryDependencies = {
    inspector, observe: vi.fn(async () => observation),
    info: vi.fn(async () => ({ workspaceId: ws.id, workspaceName: ws.name, workspaceRoot: root,
      port: runtime.port, publicUrl: null, tunnel: { running: false, provider: "none", url: null },
      tokenCount: 1, pairingActive: false, pid: runtime.pid, startedAt: "old" })),
    start: vi.fn(async () => {
      events.push("start"); expect(fs.existsSync(runtimeFile(ws.id))).toBe(false);
      writeRuntimeState(nextRuntime); observation = { state: "healthy", runtime: nextRuntime };
      return { runtime: nextRuntime, spawned: true };
    }),
    startTunnel: vi.fn(async () => "https://same.example"),
    verify: vi.fn(async () => ({ ok: true, report: { bridge: { ok: true } }, bridgeRepair: { needed: false } })),
    portFree: vi.fn(async () => processes.every(p => p.pid !== 100)),
    pause: vi.fn(async ms => { clock += ms; }), now: () => clock,
  };
  writeSession(ws.id, { conversationMode: "project", projectUrl: "https://chatgpt.com/g/project/project",
    url: "https://chatgpt.com/g/project/c/chat", taskId: "c2c_keep", savedAt: "keep" });
  const auth = write(stateDir, `auth/${ws.id}.json`, '{"token":"keep-oauth"}');
  return { root, stateDir, ws, runtime, bridge, inspector, deps, events, auth,
    setProcesses: (value: ProcessRecord[]) => { processes = value; },
    setObservation: (value: BridgeObservation) => { observation = value; } };
}

describe("controlled bridge recovery", () => {
  it("does not replace a healthy manageable Bridge", async () => {
    const f = fixture(); f.setObservation({ state: "healthy", runtime: f.runtime });
    const result = await recoverBridge(f.root, {}, f.deps);
    expect(result).toMatchObject({ ok: true, recovered: false, message: "Bridge is healthy; recovery is not needed." });
    expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
  });

  it("plans with zero side effects, then retires only proven processes before clearing runtime and starting", async () => {
    const f = fixture();
    f.setProcesses([f.bridge(100), { pid: 101, parentPid: 100, executable: "cloudflared", argv: ["cloudflared", "--token", "never-output-child"], startId: "linux:101", cwd: null },
      { pid: 500, parentPid: 1, executable: "cloudflared", argv: ["cloudflared"], startId: "unrelated", cwd: null }]);
    const before = fs.readFileSync(runtimeFile(f.ws.id), "utf8");
    const session = fs.readFileSync(sessionFile(f.ws.id), "utf8"); const auth = fs.readFileSync(f.auth, "utf8");
    const dry = await recoverBridge(f.root, { dryRun: true }, f.deps);
    expect(dry).toMatchObject({ ok: true, dryRun: true, canRecover: true, plan: { bridges: [{ pid: 100 }], descendantCount: 1, tunnel: { mode: "local" } } });
    expect(JSON.stringify(dry)).not.toMatch(/never-output/);
    expect(fs.readFileSync(runtimeFile(f.ws.id), "utf8")).toBe(before);
    expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
    const result = await recoverBridge(f.root, {}, f.deps);
    expect(result).toMatchObject({ ok: true, recovered: true, runtimeCleared: true, retired: { bridges: 1, descendants: 1 }, connectorRepairNeeded: false });
    expect(f.events).toEqual(["retire:101", "retire:100", "start"]);
    expect(fs.readFileSync(sessionFile(f.ws.id), "utf8")).toBe(session);
    expect(fs.readFileSync(f.auth, "utf8")).toBe(auth);
    expect(readRuntimeState(f.ws.id)?.instanceId).toBe("new");
  });

  it("retires every validated same-workspace Bridge and starts exactly one", async () => {
    const f = fixture(); f.setProcesses([f.bridge(100), f.bridge(102)]);
    const result = await recoverBridge(f.root, {}, f.deps);
    expect(result).toMatchObject({ ok: true, retired: { bridges: 2 } });
    expect(f.inspector.terminate).toHaveBeenCalledTimes(2); expect(f.deps.start).toHaveBeenCalledTimes(1);
  });

  it("can recover matching instance identity whose admin capability is unavailable", async () => {
    const f = fixture(); f.setObservation({ state: "healthy", runtime: f.runtime });
    f.deps.info = vi.fn(async () => { throw new BridgeAdminUnavailableError("admin_unavailable"); });
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: true, previousState: "admin_unavailable", recovered: true });
  });

  it("retires nested verified Bridges in descendant-first order", async () => {
    const f = fixture(); f.setProcesses([f.bridge(100), { ...f.bridge(102), parentPid: 100 }]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: true });
    expect(f.events).toEqual(["retire:102", "retire:100", "start"]);
  });

  it("reports all descendant generations in the read-only plan", async () => {
    const f = fixture(); f.setProcesses([f.bridge(100),
      { pid: 101, parentPid: 100, executable: "cloudflared", argv: ["cloudflared"], startId: "linux:101", cwd: null },
      { pid: 102, parentPid: 101, executable: "cloudflared", argv: ["cloudflared"], startId: "linux:102", cwd: null }]);
    expect(await recoverBridge(f.root, { dryRun: true }, f.deps)).toMatchObject({ ok: true,
      plan: { bridges: [{ pid: 100, descendants: 2 }], descendantCount: 2 } });
    expect(f.inspector.terminate).not.toHaveBeenCalled();
  });

  it("refuses a child whose recorded parent PID was reused after the child's birth", async () => {
    const f = fixture(); f.setProcesses([f.bridge(100), { pid: 101, parentPid: 100,
      executable: "cloudflared", argv: ["cloudflared"], startId: "linux:50", cwd: null }]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, canRecover: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled();
  });

  it("leaves another workspace's proven Bridge and its cloudflared alone", async () => {
    const f = fixture(); const other = makeTmpDir("recover-other"); dirs.push(other);
    f.setProcesses([f.bridge(100), f.bridge(500, other), { pid: 501, parentPid: 500, executable: "cloudflared",
      argv: ["cloudflared"], startId: "linux:501", cwd: null }]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: true, retired: { bridges: 1, descendants: 0 } });
    expect(f.events).toEqual(["retire:100", "start"]);
  });

  it("prevents concurrent start, stop and recovery during a maintenance operation", async () => {
    const f = fixture(); const lock = acquireMaintenance(f.ws.id);
    try {
      await expect(ensureBridge(f.root)).rejects.toThrow(/maintenance/);
      await expect(stopBridge(f.root)).rejects.toThrow(/maintenance/);
      expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, phase: "plan" });
      expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
    } finally { lock.release(); }
  });

  it("rechecks maintenance after health before sending an ordinary admin mutation", async () => {
    const f = fixture(); let lock: ReturnType<typeof acquireMaintenance> | undefined;
    const mutate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async url => {
      if (String(url).endsWith("/health")) {
        lock = acquireMaintenance(f.ws.id);
        return new Response(JSON.stringify({ service: "c2c-bridge", workspaceId: f.ws.id,
          instanceId: f.runtime.instanceId, status: "ok" }));
      }
      mutate(); return new Response("{}");
    }));
    try {
      await expect(adminFetch(f.runtime, "POST", "/admin/tunnel/start")).rejects.toMatchObject({ reason: "admin_unavailable" });
      expect(mutate).not.toHaveBeenCalled();
    } finally { lock?.release(); }
  });

  it.each(["workspace_mismatch", "probe_failed", "pid_unknown"] as const)("refuses ambiguous observation %s without modifications", async reason => {
    const f = fixture(); f.setObservation({ state: "unknown", reason, runtime: f.runtime });
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, canRecover: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
  });

  it.each([
    { argv: [process.execPath, entry, "serve", "--workspace", "similar"], executable: process.execPath },
    { argv: [process.execPath, entry, "not-serve", "--workspace", "same"], executable: process.execPath },
    { argv: null, executable: process.execPath },
    { argv: [process.execPath, "not-c2c.js", "serve", "--workspace", "same"], executable: process.execPath },
  ])("does not terminate an unverified listener: %j", async input => {
    const f = fixture();
    const similar = `${f.root}-similar`; fs.mkdirSync(similar); dirs.push(similar);
    const argv = input.argv?.map(arg => arg === "same" ? f.root : arg === "similar" ? similar : arg) ?? null;
    f.setProcesses([{ ...f.bridge(100), ...input, argv }]);
    const before = fs.readFileSync(runtimeFile(f.ws.id), "utf8");
    expect(await recoverBridge(f.root, { dryRun: true }, f.deps)).toMatchObject({ ok: false, canRecover: false });
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
    expect(fs.readFileSync(runtimeFile(f.ws.id), "utf8")).toBe(before);
  });

  it("blocks the entire plan if another related serve process cannot be verified", async () => {
    const f = fixture(); const bad = f.bridge(102); bad.argv!.push("--workspace", f.root);
    f.setProcesses([f.bridge(100), bad]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled();
  });

  it("does not overlook a related Bridge hidden behind an unsupported Node flag", async () => {
    const f = fixture(); const hidden = f.bridge(102);
    hidden.argv = [process.execPath, "--enable-source-maps", entry, "serve", "--workspace", f.root];
    f.setProcesses([f.bridge(100), hidden]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, canRecover: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
  });

  it("blocks an additional Node process whose argv cannot rule out a residual Bridge", async () => {
    const f = fixture(); f.setProcesses([f.bridge(100), { ...f.bridge(102), argv: null }]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, canRecover: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled();
  });

  it("canonicalizes a relative workspace and a symlink, and recognizes the bin entry", async () => {
    const f = fixture(); const alias = path.join(f.stateDir, "alias");
    fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    const processRecord = f.bridge(100, alias); processRecord.cwd = f.stateDir;
    processRecord.argv = [process.execPath, path.join(checkout, "bin/c2c.js"), "serve", "--workspace", "alias"];
    f.setProcesses([processRecord]);
    expect(await recoverBridge(f.root, { dryRun: true }, f.deps)).toMatchObject({ ok: true, canRecover: true });
  });

  it("does not treat a hard-linked CLI in another checkout as the trusted entry path", async () => {
    const f = fixture(); const foreign = path.join(f.stateDir, "foreign/dist/cli/index.js");
    fs.mkdirSync(path.dirname(foreign), { recursive: true }); fs.linkSync(entry, foreign);
    const record = f.bridge(100); record.argv![1] = foreign; f.setProcesses([record]);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, canRecover: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("accepts real Windows workspace case normalization", async () => {
    const f = fixture(); f.setProcesses([f.bridge(100, f.root.toUpperCase())]);
    expect(await recoverBridge(f.root, { dryRun: true }, f.deps)).toMatchObject({ ok: true, canRecover: true });
  });

  it("stops after a termination failure without deleting runtime or starting another instance", async () => {
    const f = fixture(); f.inspector.terminate.mockRejectedValue(new Error("cannot stop"));
    const before = fs.readFileSync(runtimeFile(f.ws.id), "utf8");
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, phase: "retire", runtimeCleared: false });
    expect(fs.readFileSync(runtimeFile(f.ws.id), "utf8")).toBe(before); expect(f.deps.start).not.toHaveBeenCalled();
  });

  it("does not proceed until children are gone and the old port is released", async () => {
    const f = fixture(); f.deps.portFree = vi.fn(async () => false);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, phase: "retire", runtimeCleared: false });
    expect(f.deps.start).not.toHaveBeenCalled(); expect(readRuntimeState(f.ws.id)?.instanceId).toBe("old");
  });

  it("retains runtime when a termination request succeeds but the process stays alive", async () => {
    const f = fixture(); f.inspector.terminate.mockImplementation(async () => {});
    const before = fs.readFileSync(runtimeFile(f.ws.id), "utf8");
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, phase: "retire", runtimeCleared: false });
    expect(fs.readFileSync(runtimeFile(f.ws.id), "utf8")).toBe(before); expect(f.deps.start).not.toHaveBeenCalled();
  });

  it("detects changed process identity before any termination", async () => {
    const f = fixture(); f.inspector.snapshot.mockImplementationOnce(async () => ({ processes: [f.bridge(100)], listeners: [100] }))
      .mockImplementation(async () => ({ processes: [{ ...f.bridge(100), startId: "reused" }], listeners: [100] }));
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false });
    expect(f.inspector.terminate).not.toHaveBeenCalled(); expect(f.deps.start).not.toHaveBeenCalled();
  });

  it("restores the existing Named Tunnel hostname without deleting auth, session or tunnel state", async () => {
    const f = fixture(); writeTunnelState({ workspaceId: f.ws.id, preference: "named", tunnelName: "existing", hostname: "same.example" });
    writeLastEndpoint({ workspaceId: f.ws.id, port: 12345, publicUrl: "https://same.example", mcpUrl: "https://same.example/mcp", connectorName: "Exact connector" });
    const before = [tunnelStateFile(f.ws.id), endpointFile(f.ws.id), sessionFile(f.ws.id)].map(file => fs.readFileSync(file, "utf8"));
    const dry = await recoverBridge(f.root, { dryRun: true }, f.deps);
    expect(dry).toMatchObject({ plan: { tunnel: { mode: "named", hostname: "same.example", restore: true } } });
    expect([tunnelStateFile(f.ws.id), endpointFile(f.ws.id), sessionFile(f.ws.id)].map(file => fs.readFileSync(file, "utf8"))).toEqual(before);
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: true, tunnel: { mode: "named", hostname: "same.example", restored: true }, connectorRepairNeeded: false });
    expect(f.deps.startTunnel).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(tunnelStateFile(f.ws.id), "utf8")).toBe(before[0]);
    expect(fs.readFileSync(sessionFile(f.ws.id), "utf8")).toBe(before[2]);
  });

  it("reports Quick Tunnel address changes through connectorRepairNeeded", async () => {
    const f = fixture(); writeTunnelState({ workspaceId: f.ws.id, preference: "quick" });
    writeLastEndpoint({ workspaceId: f.ws.id, port: 12345, publicUrl: "https://old.trycloudflare.com", mcpUrl: "https://old.trycloudflare.com/mcp", connectorName: "Keep connector" });
    f.deps.startTunnel = vi.fn(async () => "https://new.trycloudflare.com");
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: true, connectorRepairNeeded: true, chatgptRepair: { needed: true, connectorAction: "update" } });
  });

  it("keeps a configured Named Tunnel local-only when no previous public endpoint existed", async () => {
    const f = fixture(); writeTunnelState({ workspaceId: f.ws.id, preference: "named", tunnelName: "existing", hostname: "same.example" });
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: true, tunnel: { mode: "local", restored: false } });
    expect(f.deps.startTunnel).not.toHaveBeenCalled();
  });

  it("reports a changed Quick URL even when final connection validation fails", async () => {
    const f = fixture(); writeLastEndpoint({ workspaceId: f.ws.id, port: 12345, publicUrl: "https://old.trycloudflare.com",
      mcpUrl: "https://old.trycloudflare.com/mcp", connectorName: "Keep connector" });
    f.deps.startTunnel = vi.fn(async () => "https://new.trycloudflare.com");
    f.deps.verify = vi.fn(async () => ({ ok: false, report: { mcp: { ok: false } }, bridgeRepair: { needed: false } }));
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, connectorRepairNeeded: true, chatgptRepair: { needed: true } });
  });

  it("returns failure without cycling the new Bridge when final validation fails", async () => {
    const f = fixture(); f.deps.verify = vi.fn(async () => ({ ok: false, report: { mcp: { ok: false } }, bridgeRepair: { needed: false } }));
    expect(await recoverBridge(f.root, {}, f.deps)).toMatchObject({ ok: false, phase: "verify", runtimeCleared: true, bridge: { pid: 200 } });
    expect(f.deps.start).toHaveBeenCalledTimes(1);
  });
});
