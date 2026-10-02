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
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
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
});
