import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
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
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { readExecutionOutput } from "../src/execution/output.js";
import { canonicalPathFingerprint, getDefaultStateDir, getRuntimeStateDir } from "../src/config/paths.js";
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

  it("uses a shared OS runtime registry outside tests even when C2C_STATE_DIR differs", () => {
    const names = ["C2C_STATE_DIR", "C2C_RUNTIME_STATE_DIR", "VITEST", "VITEST_WORKER_ID", "NODE_ENV"] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.C2C_STATE_DIR = "D:/state-a";
      delete process.env.C2C_RUNTIME_STATE_DIR;
      delete process.env.VITEST;
      delete process.env.VITEST_WORKER_ID;
      process.env.NODE_ENV = "production";
      expect(getRuntimeStateDir()).toBe(getDefaultStateDir());
      process.env.C2C_RUNTIME_STATE_DIR = "D:/runtime-registry";
      expect(getRuntimeStateDir()).toBe(path.resolve("D:/runtime-registry"));
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses a second persisted Bridge for the same workspace and releases the lease on close", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("bridge-runtime-lease");
    dirs.push(root);
    const first = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    try {
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: true })).rejects.toThrow(/DUPLICATE_BRIDGE/);
    } finally {
      await first.close();
    }
    const replacement = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    await replacement.close();
  });

  it("keeps the Bridge and singleton lease alive when its owned tunnel fails to stop", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("bridge-tunnel-stop-failure");
    dirs.push(root);
    const stop = vi.fn().mockRejectedValueOnce(new Error("owned tunnel did not exit")).mockResolvedValue(undefined);
    const tunnel = {
      name: "cloudflare-named",
      start: vi.fn(async () => "https://named.example"),
      stop,
      restart: vi.fn(async () => "https://named.example"),
      status: () => ({ running: true, url: "https://named.example", provider: "cloudflare-named" }),
      getPublicUrl: () => "https://named.example",
      doctor: async () => ({ provider: "cloudflare-named", binaryFound: true, binaryPath: "cloudflared", running: true, url: "https://named.example", problems: [] }),
    };
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true, tunnelProvider: tunnel });
    await expect(bridge.close()).rejects.toThrow(/owned tunnel did not exit/);
    expect((await fetch(`${bridge.localBaseUrl()}/health`)).status).toBe(200);
    expect(readRuntimeState(bridge.workspace.id)?.instanceId).toBe(bridge.instanceId);
    await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: true, tunnelProvider: tunnel })).rejects.toThrow(/DUPLICATE_BRIDGE/);

    await bridge.close();
    expect(readRuntimeState(bridge.workspace.id)).toBeNull();
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

  it("reports admin-only diagnostics for the current workspace without exposing the state path", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("admin-execution-diagnostics");
    const otherRoot = makeTmpDir("admin-execution-diagnostics-other");
    dirs.push(stateDir, root, otherRoot);
    const workspace = new Workspace(root);
    const otherWorkspace = new Workspace(otherRoot);
    const record = (taskId: string, iteration: number, timestamp: string) => ({
      taskId, iteration, changedFiles: 0, tests: null, exitStatus: "ok", timestamp,
    });
    appendExecutionRecord(otherWorkspace.id, record("other-workspace-task", 9, "2026-01-01T00:00:00.000Z"));
    appendExecutionRecord(workspace.id, record("workspace-task-one", 1, "2026-01-02T00:00:00.000Z"));
    appendExecutionRecord(workspace.id, record("workspace-task-latest", 3, "2026-01-03T00:00:00.000Z"));
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    try {
      const health = await (await fetch(`${bridge.localBaseUrl()}/health`)).json() as Record<string, unknown>;
      expect(health).toEqual({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id,
        status: "ok", instanceId: bridge.instanceId });

      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      const info = await response.json() as Record<string, any>;
      expect(info).toMatchObject({ workspaceId: workspace.id, pid: process.pid, instanceId: bridge.instanceId,
        executionDiagnostics: {
          recordCount: 2,
          latestTaskId: "workspace-task-latest",
          latestIteration: 3,
          latestTimestamp: "2026-01-03T00:00:00.000Z",
        },
      });
      expect(info.executionDiagnostics.stateStoreFingerprint).toBe(canonicalPathFingerprint(stateDir));
      const serialized = JSON.stringify(info);
      expect(serialized).not.toContain(stateDir);
      expect(serialized).not.toContain(process.env.USERPROFILE ?? "__missing_userprofile__");
      expect(serialized).not.toMatch(/C2C_STATE_DIR|USERPROFILE/i);

    } finally {
      await bridge.close();
    }
  });

  it("exposes Bridge-side exact execution checks and record writes only through loopback admin capability", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("admin-execution-check");
    dirs.push(stateDir, root);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    const task = "bridge-visible-record";
    try {
      const checkUrl = `${bridge.localBaseUrl()}/admin/execution/check?task=${task}&iteration=4`;
      expect((await fetch(checkUrl)).status).toBe(404);
      const initial = await fetch(checkUrl, { headers: { Authorization: `Bearer ${bridge.adminToken}` } });
      const initialBody = await initial.json() as Record<string, any>;
      expect(initialBody).toMatchObject({ workspaceId: bridge.workspace.id, taskId: task, iteration: 4,
        exists: false, stateStoreFingerprint: canonicalPathFingerprint(stateDir) });
      expect(JSON.stringify(initialBody)).not.toContain(stateDir);

      const body = { record: { taskId: task, iteration: 4, changedFiles: ["src/a.ts"], tests: "passed",
        exitStatus: "ok", timestamp: new Date().toISOString() },
      output: { command: "pnpm test", raw: "Bridge-side output", exitCode: 0 } };
      expect((await fetch(`${bridge.localBaseUrl()}/admin/execution/record`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).status).toBe(404);
      const saved = await fetch(`${bridge.localBaseUrl()}/admin/execution/record`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const savedBody = await saved.json() as Record<string, any>;
      expect(saved.status).toBe(201);
      expect(savedBody).toMatchObject({ ok: true, workspaceId: bridge.workspace.id, taskId: task, iteration: 4,
        exists: true, outputId: 1, outputAvailable: true, stateStoreFingerprint: canonicalPathFingerprint(stateDir) });
      expect(readExecutionRecords(bridge.workspace.id)).toMatchObject([{ taskId: task, iteration: 4, outputId: 1 }]);
      expect(readExecutionOutput(bridge.workspace.id, 1)).toMatchObject({ ok: true, text: "Bridge-side output" });

      const tooLarge = { record: { ...body.record, taskId: "oversized-output", iteration: 5 },
        output: { command: "pnpm test", raw: "x".repeat(256 * 1024 + 1), exitCode: 0 } };
      const rejected = await fetch(`${bridge.localBaseUrl()}/admin/execution/record`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(tooLarge),
      });
      expect(rejected.status).toBe(413);
    } finally {
      await bridge.close();
    }
  });

  it("reports AuthStore memory and persisted-file diagnostics without exposing secrets or paths", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("admin-auth-diagnostics");
    const authDir = makeTmpDir("admin-auth-diagnostics-file");
    const authFile = path.join(authDir, "custom-auth.json");
    dirs.push(stateDir, root, authDir);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: authFile });
    try {
      const tokens = [
        bridge.authStore.issueTokens({ clientId: "diagnostic-client", scopes: ["workspace.read", "offline_access"] }),
        bridge.authStore.issueTokens({ clientId: "diagnostic-client", scopes: ["execution.read", "offline_access"] }),
        bridge.authStore.issueTokens({ clientId: "diagnostic-client", scopes: ["workspace.read"], accessTtlMs: -1000 }),
      ];
      const health = await (await fetch(`${bridge.localBaseUrl()}/health`)).json() as Record<string, unknown>;
      expect(health).not.toHaveProperty("authDiagnostics");
      expect(health).not.toHaveProperty("stateDirFingerprint");

      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      const info = await response.json() as Record<string, any>;
      const diagnostics = info.authDiagnostics;
      expect(diagnostics).toMatchObject({
        stateDirFingerprint: canonicalPathFingerprint(stateDir),
        storePathFingerprint: canonicalPathFingerprint(authFile),
        inMemoryTokenCount: 5,
        inMemoryExpiredTokenCount: 1,
        persistedTokenCount: 4,
        persistedTokenRecordCount: 4,
        refreshTokenCount: 2,
        offlineAccessRefreshCount: 2,
        persistedRefreshTokenCount: 2,
        persistedOfflineAccessRefreshCount: 2,
        latestInMemoryIssuedAt: expect.any(String),
        latestPersistedIssuedAt: expect.any(String),
        storeFileMtime: expect.any(String),
      });
      expect(Date.parse(diagnostics.latestInMemoryIssuedAt)).toBeGreaterThanOrEqual(Date.parse(diagnostics.latestPersistedIssuedAt));
      const serialized = JSON.stringify(info);
      expect(serialized).not.toContain(stateDir);
      expect(serialized).not.toContain(authFile);
      expect(serialized).not.toContain("diagnostic-client");
      for (const token of tokens) {
        for (const secret of [token.accessToken, token.refreshToken].filter(Boolean) as string[]) {
          expect(serialized).not.toContain(secret);
          expect(serialized).not.toContain(createHash("sha256").update(secret).digest("hex"));
        }
      }
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
      const spawnProcess = vi.fn();
      expect(await ensureBridge(root, {}, {
        inspector: { snapshot: async () => ({ processes: [], listeners: [], listenerOwners: [] }), terminate: async () => {} },
        observe: findBridgeObservation,
        probe: probeBridge,
        spawnProcess: spawnProcess as never,
        pause: async () => {},
      })).toEqual({ runtime: expected, spawned: false });
      expect(spawnProcess).not.toHaveBeenCalled();
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
