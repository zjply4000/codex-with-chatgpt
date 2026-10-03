import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { bridgeLeaseFile } from "../src/bridge/lease.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leaseModule = pathToFileURL(path.join(projectRoot, "src/bridge/lease.ts")).href;
const maintenanceModule = pathToFileURL(path.join(projectRoot, "src/process/maintenance.ts")).href;
const dirs: string[] = [];

afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

function launch(script: string, stateDir: string, runtimeDir: string) {
  return spawn(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: projectRoot,
    env: { ...process.env, C2C_STATE_DIR: stateDir, C2C_RUNTIME_STATE_DIR: runtimeDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function waitForText(child: ReturnType<typeof launch>, marker: string): Promise<string> {
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not emit ${marker}`)), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(marker)) { clearTimeout(timer); resolve(output); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (!output.includes(marker)) { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${output}`)); }
    });
  });
}

async function runShort(script: string, stateDir: string, runtimeDir: string): Promise<{ code: number | null; output: string }> {
  const child = launch(script, stateDir, runtimeDir);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const [code] = await once(child, "close") as [number | null];
  return { code, output };
}

async function verifyCrossStateLock(
  name: string,
  lockKind: "lease" | "maintenance"
): Promise<void> {
  const root = makeTmpDir(`shared-${name}-workspace`);
  const stateA = makeTmpDir(`shared-${name}-state-a`);
  const stateB = makeTmpDir(`shared-${name}-state-b`);
  const runtimeDir = makeTmpDir(`shared-${name}-runtime`);
  dirs.push(root, stateA, stateB, runtimeDir);
  const previousRuntimeStateDir = process.env.C2C_RUNTIME_STATE_DIR;
  process.env.C2C_RUNTIME_STATE_DIR = runtimeDir;
  const workspaceId = new Workspace(root).id;
  const moduleUrl = lockKind === "lease" ? leaseModule : maintenanceModule;
  const lockExpression = (instance: string) => lockKind === "lease"
    ? `await locks.acquireBridgeLease(${JSON.stringify(workspaceId)}, ${JSON.stringify(instance)})`
    : `locks.acquireMaintenance(${JSON.stringify(workspaceId)})`;
  const firstScript = `void (async()=>{const locks=await import(${JSON.stringify(moduleUrl)});const release=${lockExpression("first-instance")};console.log("ACQUIRED");process.on("SIGTERM",()=>{release();process.exit(0)});setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(1)})`;
  const secondScript = `void (async()=>{const locks=await import(${JSON.stringify(moduleUrl)});try{const release=${lockExpression("second-instance")};release();console.log("UNEXPECTED_ACQUIRE");process.exitCode=2}catch{console.log("BLOCKED")}})().catch(e=>{console.error(e);process.exit(1)})`;
  const first = launch(firstScript, stateA, runtimeDir);
  try {
    const ready = await waitForText(first, "ACQUIRED");
    expect(ready).toContain("ACQUIRED");
    const second = await runShort(secondScript, stateB, runtimeDir);
    expect(second.code).toBe(0);
    expect(second.output).toContain("BLOCKED");
    expect(second.output).not.toContain("UNEXPECTED_ACQUIRE");
    if (name === "Bridge lease") expect(bridgeLeaseFile(workspaceId)).toContain(runtimeDir);
  } finally {
    if (first.exitCode === null) {
      first.kill("SIGTERM");
      await once(first, "close");
    }
    if (previousRuntimeStateDir === undefined) delete process.env.C2C_RUNTIME_STATE_DIR;
    else process.env.C2C_RUNTIME_STATE_DIR = previousRuntimeStateDir;
  }
}

it("shares the Bridge lease and maintenance lock across distinct C2C_STATE_DIR processes", async () => {
  await verifyCrossStateLock("Bridge lease", "lease");
  await verifyCrossStateLock("maintenance", "maintenance");
});
