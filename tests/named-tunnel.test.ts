import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { namedTunnelBinding } from "../src/tunnel/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); dirs.splice(0).forEach(cleanup); });

it("passes the saved Tunnel UUID through the workspace binding", () => {
  expect(namedTunnelBinding({ workspaceId: "named", preference: "named", tunnelName: "display-name",
    tunnelId: "11111111-1111-4111-8111-111111111111", hostname: "named.example.com" })).toMatchObject({
    tunnelId: "11111111-1111-4111-8111-111111111111",
  });
});

it("runs an existing Named Tunnel by UUID and explicit credentials without an account certificate", async () => {
  const dir = makeTmpDir("named-run"); dirs.push(dir);
  const tunnelId = "11111111-1111-4111-8111-111111111111";
  const credential = path.join(dir, `${tunnelId}.json`);
  fs.writeFileSync(credential, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic" }));
  vi.stubEnv("TUNNEL_CRED_FILE", credential);
  vi.stubEnv("TUNNEL_ORIGIN_CERT", path.join(dir, "missing-cert.pem"));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 54321,
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", 0, signal); });
      return true;
    }) });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const tunnel = new CloudflaredNamedTunnel({ tunnelName: "display-name", tunnelId,
    hostname: "named.example.com", binaryOverride: "cloudflared" });
  try {
    const starting = tunnel.start(3333);
    child.stderr.write("Registered tunnel connection\n");
    await expect(starting).resolves.toBe("https://named.example.com");
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf("run"))).toEqual(["run", "--credentials-file", credential, tunnelId]);
    expect(args).not.toContain("display-name");
    expect(args).not.toContain("synthetic");
  } finally { await tunnel.stop(); }
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(child.exitCode).toBe(0);
});

it("shares one in-flight Named Tunnel connector between concurrent starts", async () => {
  const dir = makeTmpDir("named-concurrent"); dirs.push(dir);
  const tunnelId = "11111111-1111-4111-8111-111111111111";
  const credential = path.join(dir, `${tunnelId}.json`);
  fs.writeFileSync(credential, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic" }));
  vi.stubEnv("TUNNEL_CRED_FILE", credential);
  const makeChild = (pid: number) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid,
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn() });
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      queueMicrotask(() => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", 0, signal); });
      return true;
    });
    return child;
  };
  const firstChild = makeChild(54322), secondChild = makeChild(54323);
  const children = [firstChild, secondChild];
  vi.mocked(spawn).mockImplementation(() => children.shift() as unknown as ChildProcess);
  const tunnel = new CloudflaredNamedTunnel({ tunnelName: "display-name", tunnelId,
    hostname: "named.example.com", binaryOverride: "cloudflared" });
  const first = tunnel.start(3333);
  const second = tunnel.start(3333);
  firstChild.stderr.write("Registered tunnel connection\n");
  secondChild.stderr.write("Registered tunnel connection\n");
  const outcome = await Promise.all([first, second]);
  expect(outcome).toEqual(["https://named.example.com", "https://named.example.com"]);
  expect(spawn).toHaveBeenCalledTimes(1);
  await tunnel.stop();
});

it("waits for a timed-out Named Tunnel child to exit before rejecting or allowing another spawn", async () => {
  const dir = makeTmpDir("named-timeout-cleanup"); dirs.push(dir);
  const tunnelId = "11111111-1111-4111-8111-111111111111";
  const credential = path.join(dir, `${tunnelId}.json`);
  fs.writeFileSync(credential, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic" }));
  vi.stubEnv("TUNNEL_CRED_FILE", credential);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 54324,
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") setTimeout(() => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", 0, signal); }, 250);
      return true;
    }) });
  const spawnMock = vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredNamedTunnel({ tunnelName: "display-name", tunnelId, hostname: "named.example.com",
    binaryOverride: "cloudflared", startTimeoutMs: 10, stopGraceMs: 500, stopEscalationMs: 100 });

  const first = tunnel.start(3333);
  await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
  const retry = tunnel.start(3333);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  await expect(first).rejects.toThrow(/timed out/i);
  await expect(retry).rejects.toThrow(/timed out/i);
  expect(child.exitCode).toBe(0);
  expect(spawnMock).toHaveBeenCalledTimes(1);
});

it("escalates a timed-out Named Tunnel child and rejects only after the owned child exits", async () => {
  const dir = makeTmpDir("named-timeout-escalation"); dirs.push(dir);
  const tunnelId = "11111111-1111-4111-8111-111111111111";
  const credential = path.join(dir, `${tunnelId}.json`);
  fs.writeFileSync(credential, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic" }));
  vi.stubEnv("TUNNEL_CRED_FILE", credential);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 54326,
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") setTimeout(() => { child.exitCode = 0; child.signalCode = signal; child.emit("exit", 0, signal); }, 20);
      return true;
    }) });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const tunnel = new CloudflaredNamedTunnel({ tunnelName: "display-name", tunnelId, hostname: "named.example.com",
    binaryOverride: "cloudflared", startTimeoutMs: 10, stopGraceMs: 5, stopEscalationMs: 100 });
  const started = tunnel.start(3333);
  await expect(started).rejects.toThrow(/timed out/i);
  expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(child.exitCode).toBe(0);
});
