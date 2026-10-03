import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireBridgeLease, bridgeLeaseFile } from "../src/bridge/lease.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("Bridge process lease", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("prevents two Bridge instances in the same workspace from owning the lease", async () => {
    isolateStateDir();
    const root = makeTmpDir("bridge-lease-workspace");
    dirs.push(root);
    const workspace = new Workspace(root);
    const release = await acquireBridgeLease(workspace.id, "first-instance");
    try {
      expect(fs.existsSync(bridgeLeaseFile(workspace.id))).toBe(true);
      await expect(acquireBridgeLease(workspace.id, "second-instance")).rejects.toThrow(/DUPLICATE_BRIDGE/);
    } finally {
      release();
    }
    expect(fs.existsSync(bridgeLeaseFile(workspace.id))).toBe(false);
    const secondRelease = await acquireBridgeLease(workspace.id, "second-instance");
    secondRelease();
  });

  it("keeps a lease held by a live different PID instead of stealing it", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("bridge-lease-live-owner");
    dirs.push(stateDir, root);
    const workspace = new Workspace(root);
    const file = bridgeLeaseFile(workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, instanceId: "other-instance", leaseId: "existing-lease" }));
    await expect(acquireBridgeLease(workspace.id, "new-instance")).rejects.toThrow(/DUPLICATE_BRIDGE/);
    expect(fs.readFileSync(file, "utf8")).toContain("other-instance");
  });
});
