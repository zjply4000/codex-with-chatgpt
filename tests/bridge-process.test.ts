import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeWorkspaceRelation, identifyBridgeProcess, descendantProcessTree, discoverWorkspaceBridgeProcesses, sameBridgePath } from "../src/process/bridge-process.js";
import type { ProcessRecord } from "../src/process/inspect.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(checkout, "dist", "cli", "index.js");

function bridge(pid: number, root: string, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    pid, parentPid: 10, executable: process.execPath,
    argv: [process.execPath, entry, "serve", "--workspace", root],
    startId: `linux:${pid}`, cwd: checkout, ...overrides,
  };
}

describe("shared Bridge process identity", () => {
  it("trusts only the current checkout's exact serve grammar and canonical workspace", () => {
    const root = makeTmpDir("bridge-identity-root");
    const similar = makeTmpDir("bridge-identity-similar");
    try {
      expect(identifyBridgeProcess(bridge(100, root))).toMatchObject({ related: true, verified: true, workspaceRoot: fsRealpath(root) });
      expect(identifyBridgeProcess(bridge(101, similar))).toMatchObject({ related: true, verified: true, workspaceRoot: fsRealpath(similar) });
      const foreign = bridge(102, root, { argv: [process.execPath, path.join(root, "dist", "cli", "index.js"), "serve", "--workspace", root] });
      expect(identifyBridgeProcess(foreign)).toMatchObject({ related: true, verified: false });
      const unsupported = bridge(103, root, { argv: [process.execPath, "--enable-source-maps", entry, "serve", "--workspace", root] });
      expect(identifyBridgeProcess(unsupported)).toMatchObject({ related: true, verified: false });
    } finally {
      cleanup(root); cleanup(similar);
    }
  });

  it("ignores a listener owned by a C2C Bridge for a deleted, lexically unrelated workspace", async () => {
    const root = path.resolve("D:/Projects/sfgcdnhb");
    const parent = makeTmpDir("deleted-parent");
    const deleted = path.join(parent, "test-tmp", "deleted-workspace");
    try {
      expect(fs.existsSync(deleted)).toBe(false);
      const processRecord = bridge(19404, deleted, { cwd: null });
      const snapshot = { processes: [processRecord], listeners: [19404], listenerOwners: [{ pid: 19404, port: 48765 }] };
      const result = await discoverWorkspaceBridgeProcesses(snapshot, root, { assumedPort: 48765 });
      expect(result.blockers).toEqual([]);
      expect(result.bridges).toEqual([]);
    } finally { cleanup(parent); }
  });

  it.each([
    { label: "missing workspace flag", argv: (root: string) => [process.execPath, entry, "serve"] },
    { label: "workspace flag without value", argv: (root: string) => [process.execPath, entry, "serve", "--workspace"] },
    { label: "empty inline workspace", argv: (root: string) => [process.execPath, entry, "serve", `--workspace=${""}`] },
    { label: "workspace followed by another option", argv: (root: string) => [process.execPath, entry, "serve", "--workspace", "--port", "12345"] },
  ])("keeps malformed $label identity unknown and blocks a target listener", async ({ argv }) => {
    const target = makeTmpDir("malformed-workspace-target");
    try {
      const record = bridge(19408, target, { cwd: null, argv: argv(target) });
      const identity = identifyBridgeProcess(record);
      expect(identity.verified).toBe(false);
      expect(bridgeWorkspaceRelation(identity, target)).toBe("unknown");
      const result = await discoverWorkspaceBridgeProcesses({ processes: [record], listeners: [],
        listenerOwners: [{ pid: record.pid, port: 48765 }] }, target, { assumedPort: 48765 });
      expect(result.bridges).toEqual([]);
      expect(result.blockers).toContain(`PID ${record.pid}: Bridge identity cannot be verified.`);
    } finally { cleanup(target); }
  });

  it("blocks a missing-workspace process that matches the runtime PID even on an unrelated port", async () => {
    const target = makeTmpDir("missing-runtime-target");
    try {
      const record = bridge(19409, target, { cwd: null, argv: [process.execPath, entry, "serve"] });
      const result = await discoverWorkspaceBridgeProcesses({ processes: [record], listeners: [],
        listenerOwners: [{ pid: record.pid, port: 57851 }] }, target, { assumedPort: 48765, runtimePid: record.pid });
      expect(result.blockers).toContain(`PID ${record.pid}: Bridge identity cannot be verified.`);
    } finally { cleanup(target); }
  });

  it("keeps conflicting workspace arguments unknown instead of using one as negative proof", async () => {
    const target = makeTmpDir("conflicting-target"), other = makeTmpDir("conflicting-other");
    try {
      const record = bridge(19410, target, { cwd: null,
        argv: [process.execPath, entry, "serve", "--workspace", other, `--workspace=${target}`] });
      const identity = identifyBridgeProcess(record);
      expect(identity.workspaceArgumentCount).toBe(2);
      expect(bridgeWorkspaceRelation(identity, target)).toBe("unknown");
      const result = await discoverWorkspaceBridgeProcesses({ processes: [record], listeners: [],
        listenerOwners: [{ pid: record.pid, port: 48765 }] }, target, { assumedPort: 48765 });
      expect(result.blockers).toContain(`PID ${record.pid}: Bridge identity cannot be verified.`);
    } finally { cleanup(target); cleanup(other); }
  });

  it("keeps a deleted lexical path equal to the target workspace fail closed", async () => {
    const target = makeTmpDir("same-candidate-target");
    try {
      const unavailableCandidate = { related: true, verified: false, workspacePathCandidate: path.resolve(target) };
      expect(bridgeWorkspaceRelation(unavailableCandidate, target)).toBe("same-candidate");
      const processRecord = bridge(19405, target, { cwd: null, argv: [process.execPath, entry, "serve", "--workspace", target, "--unsupported"] });
      expect(identifyBridgeProcess(processRecord)).toMatchObject({
        related: true, verified: false, workspacePathCandidate: path.resolve(target),
      });
      const result = await discoverWorkspaceBridgeProcesses({ processes: [processRecord], listeners: [],
        listenerOwners: [{ pid: 19405, port: 48765 }] }, target, { assumedPort: 48765 });
      expect(result.bridges).toEqual([]);
      expect(result.blockers).toContain("PID 19405: Bridge identity cannot be verified.");
    } finally { cleanup(target); }
  });

  it("keeps a same lexical candidate blocked when its process entry cannot be canonicalized", async () => {
    const target = makeTmpDir("same-lexical-untrusted-entry");
    try {
      const record = bridge(19411, target, { cwd: null,
        argv: [process.execPath, path.join(target, "dist", "cli", "index.js"), "serve", "--workspace", target] });
      const identity = identifyBridgeProcess(record);
      expect(identity.workspaceRoot).toBeUndefined();
      expect(bridgeWorkspaceRelation(identity, target)).toBe("same-candidate");
      const result = await discoverWorkspaceBridgeProcesses({ processes: [record], listeners: [],
        listenerOwners: [{ pid: record.pid, port: 48765 }] }, target, { assumedPort: 48765 });
      expect(result.blockers).toContain(`PID ${record.pid}: Bridge identity cannot be verified.`);
    } finally { cleanup(target); }
  });

  it("does not declare a relative workspace safe without cwd when it could own the target listener", async () => {
    const target = makeTmpDir("relative-no-cwd");
    const processRecord = bridge(19406, target, { argv: [process.execPath, entry, "serve", "--workspace", "."], cwd: null });
    const result = await discoverWorkspaceBridgeProcesses({ processes: [processRecord], listeners: [],
      listenerOwners: [{ pid: 19406, port: 48765 }] }, target, { assumedPort: 48765 });
    expect(result.bridges).toEqual([]);
    expect(result.blockers).toContain("PID 19406: Bridge identity cannot be verified.");
    cleanup(target);
  });

  it("compares canonical paths without accepting a similarly named workspace", () => {
    const root = makeTmpDir("bridge-path-root");
    const similar = `${root}-other`;
    try {
      expect(sameBridgePath(root, fsRealpath(root))).toBe(true);
      expect(sameBridgePath(root, similar)).toBe(false);
    } finally { cleanup(root); }
  });

  it("ignores a verified process for a different existing workspace", async () => {
    const target = makeTmpDir("existing-target");
    const other = makeTmpDir("existing-other");
    try {
      const processRecord = bridge(19407, other, { cwd: null });
      const result = await discoverWorkspaceBridgeProcesses({ processes: [processRecord], listeners: [19407],
        listenerOwners: [{ pid: 19407, port: 57851 }] }, target, { assumedPort: 48765 });
      expect(result).toEqual({ bridges: [], blockers: [] });
    } finally { cleanup(target); cleanup(other); }
  });

  it("requires each same-workspace process to own exactly one matching healthy listener", async () => {
    const root = makeTmpDir("bridge-listener-root");
    try {
      const first = bridge(100, root), second = bridge(101, root);
      const snapshot = { processes: [first, second], listeners: [100], listenerOwners: [
        { pid: 100, port: 48765 }, { pid: 101, port: 12780 },
      ] };
      const result = await discoverWorkspaceBridgeProcesses(snapshot, root, { probe: async (port) => ({
        service: "c2c-bridge", version: "0.1.3", workspaceId: new Workspace(root).id,
        status: "ok", instanceId: port === 48765 ? "first" : "second",
      }) });
      expect(result.blockers).toEqual([]);
      expect(result.bridges).toMatchObject([{ record: { pid: 100 }, port: 48765, instanceId: "first" },
        { record: { pid: 101 }, port: 12780, instanceId: "second" }]);

      const mismatched = await discoverWorkspaceBridgeProcesses({ ...snapshot, listenerOwners: [{ pid: 100, port: 48765 }] }, root, {
        probe: async () => ({ service: "c2c-bridge", version: "0.1.3", workspaceId: "another", status: "ok", instanceId: "wrong" }),
      });
      expect(mismatched.bridges).toEqual([]);
      expect(mismatched.blockers).toHaveLength(2);
    } finally { cleanup(root); }
  });

  it("retires a verified process tree descendants-first and blocks reused parent identities", () => {
    const root = makeTmpDir("bridge-tree-root");
    try {
      const processes = [bridge(100, root, { startId: "windows:2026-10-03T10:00:00.000Z" }),
        { pid: 101, parentPid: 100, executable: "cloudflared.exe", argv: ["cloudflared.exe", "tunnel"], startId: "windows:2026-10-03T10:00:01.000Z", cwd: root },
        { pid: 102, parentPid: 101, executable: "helper.exe", argv: ["helper.exe"], startId: "windows:2026-10-03T10:00:02.000Z", cwd: root },
      ];
      expect(descendantProcessTree({ processes, listeners: [], listenerOwners: [] }, [processes[0]!]))
        .toMatchObject({ records: [{ pid: 102 }, { pid: 101 }, { pid: 100 }], blockers: [] });

      const reused = { ...processes[1]!, startId: "windows:2026-10-03T09:59:59.000Z" };
      expect(descendantProcessTree({ processes: [processes[0]!, reused], listeners: [], listenerOwners: [] }, [processes[0]!]).blockers.length)
        .toBeGreaterThan(0);
    } finally { cleanup(root); }
  });
});

function fsRealpath(input: string): string {
  return path.resolve(input);
}
