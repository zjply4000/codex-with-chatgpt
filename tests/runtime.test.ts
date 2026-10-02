import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  readRuntimeState,
  probeBridge,
  runtimeFile,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
    instanceId: "test-instance",
  };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const saved = readRuntimeState(bridge.workspace.id);
      const health = await probeBridge(bridge.port);
      expect(saved?.instanceId).toEqual(expect.any(String));
      expect(health?.instanceId).toBe(saved?.instanceId);
      expect(health).toEqual({ service: SERVICE_NAME, version: VERSION, workspaceId: bridge.workspace.id,
        status: "ok", instanceId: saved?.instanceId });
      // Public identity neither grants admin access nor bypasses proxy rejection.
      expect((await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { Authorization: `Bearer ${health?.instanceId}` },
      })).status).toBe(404);
      for (const proxyHeader of ["x-forwarded-for", "cf-connecting-ip"]) {
        expect((await fetch(`${bridge.localBaseUrl()}/admin/info`, {
          headers: { Authorization: `Bearer ${bridge.adminToken}`, [proxyHeader]: "127.0.0.1" },
        })).status).toBe(404);
      }
      expect((await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      })).status).toBe(200);
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it.each([
    { runtimeInstance: "old-instance", healthInstance: "live-instance", workspaceMatches: true, reason: "stale_runtime" },
    { runtimeInstance: undefined, healthInstance: "live-instance", workspaceMatches: true, reason: "stale_runtime" },
    { runtimeInstance: "live-instance", healthInstance: undefined, workspaceMatches: true, reason: "stale_runtime" },
    { runtimeInstance: undefined, healthInstance: undefined, workspaceMatches: true, reason: "stale_runtime" },
    { runtimeInstance: "live-instance", healthInstance: "live-instance", workspaceMatches: false, reason: "workspace_mismatch" },
  ])("does not trust another or unverifiable live instance: %j", async ({ runtimeInstance, healthInstance, workspaceMatches, reason }) => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("obs-instance");
    dirs.push(stateDir, root);
    const workspace = new Workspace(root);
    const runtime = { ...stubRuntime(workspace.id, root, 999_999_999, 12345), instanceId: runtimeInstance };
    writeRuntimeState(runtime);
    const before = fs.readFileSync(runtimeFile(workspace.id), "utf8");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      service: SERVICE_NAME, version: VERSION, workspaceId: workspaceMatches ? workspace.id : "another-workspace",
      status: "ok", instanceId: healthInstance,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const kill = vi.spyOn(process, "kill");

    expect(await findBridgeObservation(workspace.id)).toMatchObject({ state: "unknown", reason });
    expect(await findLiveBridge(workspace.id)).toBeNull();
    await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    await expect(adminFetch(runtime, "GET", "/admin/info")).rejects.toThrow(/stale_runtime/);
    await expect(stopBridge(root)).rejects.toThrow(/uncertain/);
    expect(fs.existsSync(path.join(stateDir, "logs"))).toBe(false);
    expect(fs.readFileSync(runtimeFile(workspace.id), "utf8")).toBe(before);
    expect(kill).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/health"))).toBe(true);
  });

  it("reuses the exact live instance without spawning a daemon", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("obs-reuse");
    dirs.push(stateDir, root);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    try {
      const expected = readRuntimeState(bridge.workspace.id);
      expect(await ensureBridge(root)).toEqual({ runtime: expected, spawned: false });
      expect(fs.existsSync(path.join(stateDir, "logs"))).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it("keeps legacy records unverified even when their saved PID is missing", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-legacy-probe");
    dirs.push(root);
    const workspace = new Workspace(root);
    const runtime = stubRuntime(workspace.id, root, 999_999_999, 1);
    delete runtime.instanceId;
    writeRuntimeState(runtime);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("probe unavailable"); }));
    expect(await findBridgeObservation(workspace.id)).toMatchObject({ state: "unknown", reason: "stale_runtime" });
    await expect(ensureBridge(root)).rejects.toThrow(/stale_runtime/);
  });

  it("classifies admin transport failure after matching health as lost admin capability", async () => {
    const runtime = stubRuntime("workspace", "workspace", process.pid, 12345);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ service: SERVICE_NAME, workspaceId: runtime.workspaceId,
          instanceId: runtime.instanceId, version: VERSION, status: "ok" }), { status: 200 });
      }
      throw new Error("admin transport unavailable");
    }));
    await expect(adminFetch(runtime, "POST", "/admin/tunnel/start")).rejects.toMatchObject({ reason: "admin_unavailable" });
  });
});
