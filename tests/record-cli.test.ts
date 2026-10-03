import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listExecutionOutputs } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords, type ExecutionRecord } from "../src/execution/records.js";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.once("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

function runRecord(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return runCli(["record", "--workspace", root, "--task", "c2c_test", ...args], env);
}

function runRecordCheck(root: string, task: string, iteration: number, env: NodeJS.ProcessEnv) {
  return runCli(["record-check", "--workspace", root, "--task", task, "--iteration", String(iteration), "--json"], env);
}

async function withRecordEnvironment(run: (root: string, workspace: Workspace) => void | Promise<void>): Promise<void> {
  const root = makeTmpDir("record-cli-workspace");
  const stateDir = makeTmpDir("record-cli-state");
  const runtimeDir = makeTmpDir("record-cli-runtime-registry");
  const previousStateDir = process.env.C2C_STATE_DIR;
  const previousRuntimeStateDir = process.env.C2C_RUNTIME_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_RUNTIME_STATE_DIR = runtimeDir;

  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    await run(root, new Workspace(root));
  } finally {
    await bridge?.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    if (previousRuntimeStateDir === undefined) delete process.env.C2C_RUNTIME_STATE_DIR;
    else process.env.C2C_RUNTIME_STATE_DIR = previousRuntimeStateDir;
    cleanup(root);
    cleanup(stateDir);
    cleanup(runtimeDir);
  }
}

describe("c2c record", () => {
  it("records valid numeric options and command output", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, [
        "--iteration",
        "2",
        "--changed-files",
        "3",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "1",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 2, changedFiles: 3 }),
      ]);
      expect(listExecutionOutputs(workspace.id)).toEqual([
        expect.objectContaining({ command: "pnpm test", exitCode: 1, iteration: 2 }),
      ]);
    });
  });

  it("records the executor that ran the iteration", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, ["--iteration", "1", "--executor", "claude-code"]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 1, executor: "claude-code" }),
      ]);
    });
  });

  it("keeps recording when no executor is given, so older callers still work", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, ["--iteration", "1"]);

      expect(result.status).toBe(0);
      const [record] = readExecutionRecords(workspace.id);
      expect(record.taskId).toBe("c2c_test");
      expect(record.executor).toBeUndefined();
    });
  });

  it("verifies an exact task and iteration in the active Bridge execution store", async () => {
    await withRecordEnvironment(async (root) => {
      expect((await runRecord(root, ["--iteration", "2"])).status).toBe(0);
      const checkTwo = await runRecordCheck(root, "c2c_test", 2, process.env);
      const checkOne = await runRecordCheck(root, "c2c_test", 1, process.env);
      expect(checkTwo.status).toBe(0);
      expect(JSON.parse(checkTwo.stdout)).toMatchObject({ ok: true, taskId: "c2c_test", iteration: 2 });
      expect(checkOne.status).toBe(1);
    });
  });

  it("does not accept a local record when no healthy Bridge can verify it", async () => {
    const root = makeTmpDir("record-no-bridge-workspace");
    const stateDir = makeTmpDir("record-no-bridge-state");
    const runtimeDir = makeTmpDir("record-no-bridge-runtime");
    const workspace = new Workspace(root);
    const previousStateDir = process.env.C2C_STATE_DIR;
    const previousRuntimeStateDir = process.env.C2C_RUNTIME_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    process.env.C2C_RUNTIME_STATE_DIR = runtimeDir;
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    try {
      appendExecutionRecord(workspace.id, { taskId: "local-only", iteration: 1, changedFiles: 0,
        tests: "passed", exitStatus: "ok", timestamp: new Date().toISOString() });
      await bridge.close();
      const result = await runRecordCheck(root, "local-only", 1, process.env);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false,
        error: expect.stringContaining("BRIDGE_EXECUTION_CHECK_UNAVAILABLE") });
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
      if (previousRuntimeStateDir === undefined) delete process.env.C2C_RUNTIME_STATE_DIR;
      else process.env.C2C_RUNTIME_STATE_DIR = previousRuntimeStateDir;
      cleanup(root); cleanup(stateDir); cleanup(runtimeDir);
    }
  });

  it("routes record, output, and exact checks to the Bridge store when CLI and Bridge state dirs differ", async () => {
    const root = makeTmpDir("record-bridge-store-workspace");
    const cliStateDir = makeTmpDir("record-bridge-store-cli");
    const bridgeStateDir = makeTmpDir("record-bridge-store-bridge");
    const runtimeDir = makeTmpDir("record-bridge-store-runtime");
    const workspace = new Workspace(root);
    const previousStateDir = process.env.C2C_STATE_DIR;
    const previousRuntimeStateDir = process.env.C2C_RUNTIME_STATE_DIR;
    process.env.C2C_STATE_DIR = bridgeStateDir;
    process.env.C2C_RUNTIME_STATE_DIR = runtimeDir;
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
      const cliEnv = { ...process.env, C2C_STATE_DIR: cliStateDir, C2C_RUNTIME_STATE_DIR: runtimeDir };

      process.env.C2C_STATE_DIR = cliStateDir;
      appendExecutionRecord(workspace.id, {
        taskId: "c2c_cli_only", iteration: 7, changedFiles: 0, tests: "seed in A", exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
      process.env.C2C_STATE_DIR = bridgeStateDir;

      const onlyA = await runRecordCheck(root, "c2c_cli_only", 7, cliEnv);
      expect(onlyA.status).toBe(1);
      expect(JSON.parse(onlyA.stdout)).toMatchObject({ ok: false, error: expect.stringContaining("STORE_MISMATCH") });
      expect(onlyA.stdout).not.toContain(cliStateDir);
      expect(onlyA.stdout).not.toContain(bridgeStateDir);

      const saved = await runRecord(root, ["--iteration", "8", "--command", "pnpm test", "--output", "Bridge output body"], cliEnv);
      expect(saved.status, saved.stderr).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: "c2c_test", iteration: 8, outputId: 1, outputAvailable: true }),
      ]));
      expect(listExecutionOutputs(workspace.id)).toEqual([
        expect.objectContaining({ command: "pnpm test", taskId: "c2c_test", iteration: 8 }),
      ]);

      process.env.C2C_STATE_DIR = cliStateDir;
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_cli_only", iteration: 7 }),
      ]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
      process.env.C2C_STATE_DIR = bridgeStateDir;

      const verified = await runRecordCheck(root, "c2c_test", 8, cliEnv);
      expect(verified.status, verified.stderr).toBe(0);
      const result = JSON.parse(verified.stdout);
      expect(result).toMatchObject({ ok: true, taskId: "c2c_test", iteration: 8,
        storeBinding: "bridge", configuredStateDirDiffers: true,
        bridgeRecordExists: true,
        bridgeExecutionStoreFingerprint: expect.any(String), selectedExecutionStoreFingerprint: expect.any(String),
        configuredStateDirFingerprint: expect.any(String) });
      expect(result.bridgeExecutionStoreFingerprint).toBe(result.selectedExecutionStoreFingerprint);
      expect(result.bridgeExecutionStoreFingerprint).not.toBe(result.configuredStateDirFingerprint);
      expect(verified.stdout).not.toContain(cliStateDir);
      expect(verified.stdout).not.toContain(bridgeStateDir);
    } finally {
      await bridge?.close();
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
      if (previousRuntimeStateDir === undefined) delete process.env.C2C_RUNTIME_STATE_DIR;
      else process.env.C2C_RUNTIME_STATE_DIR = previousRuntimeStateDir;
      cleanup(root); cleanup(cliStateDir); cleanup(bridgeStateDir); cleanup(runtimeDir);
    }
  });

  it("rejects a non-integer iteration without recording the execution", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, ["--iteration", "abc"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects an unsafe changed-file count before recording command output", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, [
        "--iteration",
        "1",
        "--changed-files",
        "9".repeat(400),
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("rejects a negative changed-file count", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, ["--iteration", "1", "--changed-files=-1"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects a non-integer exit code before recording command output", async () => {
    await withRecordEnvironment(async (root, workspace) => {
      const result = await runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "abc",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });
});

describe("execution record persistence", () => {
  it("rejects invalid records at the write boundary", async () => {
    await withRecordEnvironment((_root, workspace) => {
      const invalidRecord: ExecutionRecord = {
        taskId: "c2c_invalid",
        iteration: Number.NaN,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      };

      expect(() => appendExecutionRecord(workspace.id, invalidRecord)).toThrow();
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });
});
