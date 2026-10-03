import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBridge, restartBridge, type EnsureBridgeDependencies } from "../src/process/daemon.js";
import { discoverWorkspaceBridgeProcesses } from "../src/process/bridge-process.js";
import type { ProcessRecord, ProcessSnapshot } from "../src/process/inspect.js";
import { readRuntimeState, runtimeFile, writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(checkout, "dist", "cli", "index.js");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

function fixture() {
  const stateDir = isolateStateDir();
  const root = makeTmpDir("bridge-singleton-workspace");
  dirs.push(stateDir, root);
  const workspace = new Workspace(root);
  const runtime: RuntimeState = { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id,
    workspaceRoot: root, pid: 100, port: 48765, adminToken: "test-admin", publicUrl: null,
    startedAt: "started", instanceId: "instance-100" };
  const bridge = (pid: number, port: number): ProcessRecord => ({ pid, parentPid: 9, executable: process.execPath,
    argv: [process.execPath, entry, "serve", "--workspace", root], startId: `windows:2026-10-03T10:00:${String(pid % 60).padStart(2, "0")}.000Z`, cwd: checkout });
  const snapshot: ProcessSnapshot = { processes: [bridge(100, 48765), bridge(101, 12780)], listeners: [100],
    listenerOwners: [{ pid: 100, port: 48765 }, { pid: 101, port: 12780 }] };
  const spawnProcess = vi.fn(() => ({ pid: 900, exitCode: null, unref: vi.fn() }));
  const deps: EnsureBridgeDependencies = {
    inspector: { snapshot: vi.fn(async () => snapshot), terminate: vi.fn(async () => {}) },
    observe: vi.fn(async () => ({ state: "healthy", runtime })),
    probe: vi.fn(async (port: number) => ({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id,
      status: "ok", instanceId: port === 48765 ? "instance-100" : "instance-101" })),
    spawnProcess,
    pause: vi.fn(async () => {}),
  };
  return { root, workspace, runtime, bridge, snapshot, deps, spawnProcess };
}

describe("Bridge singleton startup guard", () => {
  it("refuses a third process when two verified Bridges serve the same workspace", async () => {
    const f = fixture();
    await expect(ensureBridge(f.root, {}, f.deps)).rejects.toThrow(/DUPLICATE_BRIDGE/);
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });

  it("reuses the exact single live Bridge and does not spawn", async () => {
    const f = fixture();
    f.snapshot.processes = [f.bridge(100, 48765)];
    f.snapshot.listeners = [100];
    f.snapshot.listenerOwners = [{ pid: 100, port: 48765 }];
    const result = await ensureBridge(f.root, {}, f.deps);
    expect(result).toEqual({ runtime: f.runtime, spawned: false });
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });

  it("does not fall back to a random port when a verified same-workspace Bridge owns the default port", async () => {
    const f = fixture();
    f.snapshot.processes = [f.bridge(100, 48765)];
    f.snapshot.listeners = [100];
    f.snapshot.listenerOwners = [{ pid: 100, port: 48765 }];
    f.deps.observe = vi.fn(async () => ({ state: "stopped", runtime: null, reason: "pid_missing" }));
    await expect(ensureBridge(f.root, {}, f.deps)).rejects.toThrow(/DUPLICATE_BRIDGE/);
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });

  it("waits for its own newly spawned Bridge to bind before diagnosing its listener", async () => {
    const f = fixture();
    const runtime: RuntimeState = { ...f.runtime, pid: 900, instanceId: "new-instance", adminToken: "new-admin" };
    let processRecord: ProcessRecord | null = null;
    let listening = false;
    let pauses = 0;
    const deps: EnsureBridgeDependencies = {
      inspector: { snapshot: vi.fn(async () => ({
        processes: processRecord ? [processRecord] : [],
        listeners: listening ? [900] : [],
        listenerOwners: listening ? [{ pid: 900, port: 48765 }] : [],
      })), terminate: vi.fn(async () => {}) },
      observe: vi.fn(async () => listening ? { state: "healthy", runtime } : { state: "stopped", runtime: null, reason: "runtime_missing" }),
      probe: vi.fn(async () => listening ? { service: SERVICE_NAME, version: VERSION, workspaceId: f.workspace.id,
        status: "ok", instanceId: runtime.instanceId } : null),
      spawnProcess: vi.fn(() => {
        processRecord = { pid: 900, parentPid: process.pid, executable: process.execPath,
          argv: [process.execPath, entry, "serve", "--workspace", f.root],
          startId: "windows:2026-10-03T12:00:00.000Z", cwd: checkout };
        return { pid: 900, exitCode: null, unref: vi.fn() } as never;
      }),
      pause: vi.fn(async () => { pauses++; if (pauses > 1) listening = true; }),
    };
    const result = await ensureBridge(f.root, {}, deps);
    expect(result).toEqual({ runtime, spawned: true });
    expect(deps.spawnProcess).toHaveBeenCalledTimes(1);
    expect(deps.inspector.snapshot).toHaveBeenCalledTimes(3);
  });

  it("retires only its exact spawned child when a duplicate is detected after spawn", async () => {
    const f = fixture();
    const spawnedPid = 2_000_000_000;
    let processes: ProcessRecord[] = [];
    let spawned!: ProcessRecord;
    const existing = f.bridge(100, 12780);
    let spawnedOnce = false;
    const inspector = {
      snapshot: vi.fn(async () => ({ processes: [...processes], listeners: [100, spawnedPid], listenerOwners: [
        { pid: 100, port: 12780 }, { pid: spawnedPid, port: 48765 },
      ] })),
      terminate: vi.fn(async (record: ProcessRecord) => { processes = processes.filter((item) => item.pid !== record.pid); }),
    };
    const deps: EnsureBridgeDependencies = {
      inspector,
      observe: vi.fn(async () => ({ state: "stopped", runtime: null, reason: "runtime_missing" })),
      probe: vi.fn(async (port) => ({ service: SERVICE_NAME, version: VERSION, workspaceId: f.workspace.id, status: "ok",
        instanceId: port === 12780 ? "existing-instance" : "spawned-instance" })),
      spawnProcess: vi.fn((command, args) => {
        if (!spawnedOnce) {
          spawned = { pid: spawnedPid, parentPid: process.pid, executable: command, argv: [command, ...args],
            startId: "windows:2026-10-03T12:01:00.000Z", cwd: process.cwd() };
          processes = [existing, spawned]; spawnedOnce = true;
        }
        return { pid: spawnedPid, exitCode: null, unref: vi.fn() } as never;
      }),
      pause: vi.fn(async () => {}),
    };

    let failure: Error | undefined;
    try { await ensureBridge(f.root, {}, deps); } catch (error) { failure = error as Error; }
    expect(failure?.message).toMatch(/DUPLICATE_BRIDGE/);
    expect(inspector.terminate.mock.calls.length, failure?.message).toBe(1);
    expect(inspector.terminate).toHaveBeenCalledWith(spawned);
    expect(processes.map((record) => record.pid)).toEqual([100]);
  });

  it("retires its spawned child when the startup scan reports an unrelated blocker", async () => {
    const f = fixture();
    const spawnedPid = 2_000_000_001;
    let spawned!: ProcessRecord;
    const blocker: ProcessRecord = { pid: 501, parentPid: 1, executable: process.execPath,
      argv: [process.execPath, entry, "serve", "--workspace", f.root, "--unsupported"],
      startId: "windows:2026-10-03T12:00:00.000Z", cwd: null };
    let processes: ProcessRecord[] = [];
    const inspector = {
      snapshot: vi.fn(async () => ({ processes: [...processes], listeners: [], listenerOwners: [] })),
      terminate: vi.fn(async (record: ProcessRecord) => { processes = processes.filter((item) => item.pid !== record.pid); }),
    };
    const deps: EnsureBridgeDependencies = {
      inspector,
      observe: vi.fn(async () => ({ state: "stopped", runtime: null, reason: "runtime_missing" })),
      probe: vi.fn(async () => null),
      spawnProcess: vi.fn((command, args) => {
        spawned = { pid: spawnedPid, parentPid: process.pid, executable: command, argv: [command, ...args],
          startId: "windows:2026-10-03T12:02:00.000Z", cwd: process.cwd() };
        processes = [spawned, blocker];
        return { pid: spawnedPid, exitCode: null, unref: vi.fn() } as never;
      }),
      pause: vi.fn(async () => {}),
    };

    await expect(ensureBridge(f.root, {}, deps)).rejects.toThrow(/BRIDGE_IDENTITY_UNVERIFIED/);
    expect(inspector.terminate).toHaveBeenCalledTimes(1);
    expect(inspector.terminate).toHaveBeenCalledWith(spawned);
    expect(processes.map((record) => record.pid)).toEqual([501]);
  });

  it("retires its spawned child on startup timeout", async () => {
    const f = fixture();
    const spawnedPid = 2_000_000_002;
    let spawned!: ProcessRecord;
    let processes: ProcessRecord[] = [];
    const inspector = {
      snapshot: vi.fn(async () => ({ processes: [...processes], listeners: [], listenerOwners: [] })),
      terminate: vi.fn(async (record: ProcessRecord) => { processes = processes.filter((item) => item.pid !== record.pid); }),
    };
    const deps: EnsureBridgeDependencies = {
      inspector,
      observe: vi.fn(async () => ({ state: "stopped", runtime: null, reason: "runtime_missing" })),
      probe: vi.fn(async () => null),
      spawnProcess: vi.fn((command, args) => {
        spawned = { pid: spawnedPid, parentPid: process.pid, executable: command, argv: [command, ...args],
          startId: "windows:2026-10-03T12:03:00.000Z", cwd: process.cwd() };
        processes = [spawned];
        return { pid: spawnedPid, exitCode: null, unref: vi.fn() } as never;
      }),
      pause: vi.fn(async () => {}),
      startupTimeoutMs: 5,
    };

    await expect(ensureBridge(f.root, {}, deps)).rejects.toThrow(/verified singleton within 5ms/);
    expect(inspector.terminate).toHaveBeenCalledTimes(1);
    expect(inspector.terminate).toHaveBeenCalledWith(spawned);
    expect(processes).toEqual([]);
  });

  it("does not mistake an unrelated default-port listener for a same-workspace Bridge", async () => {
    const f = fixture();
    f.snapshot.processes = [{ pid: 501, parentPid: 1, executable: "other-server.exe",
      argv: ["other-server.exe"], startId: "windows:2026-10-03T09:00:00Z", cwd: null }];
    f.snapshot.listeners = [501];
    f.snapshot.listenerOwners = [{ pid: 501, port: 48765 }];
    const discovery = await discoverWorkspaceBridgeProcesses(f.snapshot, f.root, { probe: f.deps.probe });
    expect(discovery).toEqual({ bridges: [], blockers: [] });
  });

  it("restart retires every verified Bridge and its cloudflared descendants before starting one", async () => {
    const f = fixture();
    let processes: ProcessRecord[] = [
      f.bridge(100, 48765),
      { pid: 110, parentPid: 100, executable: "cloudflared.exe", argv: ["cloudflared.exe", "tunnel", "--url", "http://127.0.0.1:48765"], startId: "windows:2026-10-03T10:01:40.000Z", cwd: f.root },
      f.bridge(102, 12780),
      { pid: 112, parentPid: 102, executable: "cloudflared.exe", argv: ["cloudflared.exe", "tunnel", "--url", "http://127.0.0.1:12780"], startId: "windows:2026-10-03T10:01:42.000Z", cwd: f.root },
      { pid: 300, parentPid: 1, executable: "cloudflared.exe", argv: ["cloudflared.exe", "tunnel", "--url", "http://127.0.0.1:48765", "unrelated-tunnel"], startId: "windows:2026-10-03T09:00:00.000Z", cwd: f.root },
    ];
    const oldRuntime = { ...f.runtime, publicUrl: null };
    writeRuntimeState(oldRuntime);
    let runtime: RuntimeState | null = oldRuntime;
    const events: string[] = [];
    const snapshot = async (port: number): Promise<ProcessSnapshot> => {
      const listenerOwners = processes.filter((p) => p.argv?.includes("serve")).map((p) => ({
        pid: p.pid, port: p.pid === 100 ? 48765 : p.pid === 102 ? 12780 : 48765,
      }));
      return { processes: [...processes], listenerOwners, listeners: listenerOwners.filter((p) => p.port === port).map((p) => p.pid) };
    };
    const newRuntime: RuntimeState = { ...oldRuntime, pid: 200, port: 48765, instanceId: "restarted-instance", adminToken: "new-admin" };
    const deps: EnsureBridgeDependencies = {
      inspector: { snapshot, terminate: async (record) => { events.push(`retire:${record.pid}`); processes = processes.filter((p) => p.pid !== record.pid); } },
      observe: async () => {
        if (runtime && processes.some((p) => p.pid === runtime!.pid)) {
          return runtime.pid === 100
            ? { state: "unknown", runtime, reason: "workspace_mismatch" }
            : { state: "healthy", runtime };
        }
        return { state: "stopped", runtime: null, reason: "pid_missing" };
      },
      probe: async (port) => {
        const bridge = port === 48765 ? processes.find((p) => p.pid === 100 || p.pid === 200) : processes.find((p) => p.pid === 102);
        const instanceId = bridge?.pid === 200 ? newRuntime.instanceId : bridge?.pid === 100 ? oldRuntime.instanceId : "second-instance";
        return bridge ? { service: SERVICE_NAME, version: VERSION, workspaceId: f.workspace.id, status: "ok", instanceId } : null;
      },
      spawnProcess: () => {
        events.push("start"); runtime = newRuntime; writeRuntimeState(newRuntime);
        processes.push({ ...f.bridge(200, 48765), startId: "windows:2026-10-03T10:02:00.000Z" });
        return { pid: 200, exitCode: null, unref: vi.fn() } as never;
      },
      pause: async () => {},
    };

    const result = await restartBridge(f.root, {}, deps);

    expect(result.runtime?.instanceId).toBe("restarted-instance");
    expect(events).toEqual(["retire:110", "retire:112", "retire:100", "retire:102", "start"]);
    expect(processes.filter((p) => p.argv?.includes("serve")).map((p) => p.pid)).toEqual([200]);
    expect(processes.map((p) => p.pid)).toContain(300);
    expect(readRuntimeState(f.workspace.id)?.pid).toBe(200);
    expect(fs.existsSync(runtimeFile(f.workspace.id))).toBe(true);
  });
});
