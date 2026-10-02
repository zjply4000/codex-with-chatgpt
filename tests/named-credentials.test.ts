import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflaredCredentialPath, hasCloudflaredCert, inspectNamedTunnelCredentials,
  namedTunnelCredentialRepairMessage, provisionNamedTunnel, type CloudflaredAccount } from "../src/tunnel/named-provision.js";
import { ProcessCloudflaredAccount } from "../src/tunnel/named-provision.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
const tunnelId = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  dirs.splice(0).forEach(cleanup);
});

describe("Named Tunnel run and management readiness", () => {
  it.each(["darwin", "linux"] as const)("finds Unix credentials in default directory order (%s)", (platform) => {
    const home = makeTmpDir("named-home"), fixture = makeTmpDir("named-system-credentials");
    dirs.push(home, fixture);
    vi.stubEnv("TUNNEL_CRED_FILE", undefined);
    vi.stubEnv("TUNNEL_ORIGIN_CERT", path.join(home, "missing-cert.pem"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const source = write(fixture, "credentials.json", JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic" }));
    const realStat = fs.statSync.bind(fs), realRead = fs.readFileSync.bind(fs);
    const available = new Set<string>();
    const candidates = [path.join(home, ".cloudflared", `${tunnelId}.json`),
      path.join("/etc/cloudflared", `${tunnelId}.json`), path.join("/usr/local/etc/cloudflared", `${tunnelId}.json`)];
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => {
      if (candidates.includes(String(file))) {
        if (available.has(String(file))) return realStat(source);
        throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      }
      return realStat(file);
    }) as typeof fs.statSync);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options: unknown) =>
      realRead(available.has(String(file)) ? source : file, options as never)) as typeof fs.readFileSync);
    for (const candidate of [...candidates].reverse()) {
      available.add(candidate);
      expect(cloudflaredCredentialPath(tunnelId, platform)).toBe(candidate);
      expect(inspectNamedTunnelCredentials(tunnelId, platform)).toMatchObject({ status: "ready", credentialPath: candidate });
    }
  });

  it("does not fall back from an explicitly configured missing credential", () => {
    const home = makeTmpDir("named-override"); dirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    write(home, `.cloudflared/${tunnelId}.json`, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic" }));
    vi.stubEnv("TUNNEL_CRED_FILE", path.join(home, "missing.json"));
    expect(inspectNamedTunnelCredentials(tunnelId).status).toBe("missing_credentials");
  });

  it.each(["darwin", "linux"] as const)("uses Unix credential repair paths (%s)", (platform) => {
    const message = namedTunnelCredentialRepairMessage("missing_credentials", platform);
    expect(message).not.toContain("%USERPROFILE%");
    expect(message).toContain("~/.cloudflared");
  });

  it("requires login only before account management operations", async () => {
    const state = makeTmpDir("named-management-state"); dirs.push(state);
    vi.stubEnv("C2C_STATE_DIR", state);
    const home = makeTmpDir("named-management"); dirs.push(home);
    vi.stubEnv("TUNNEL_ORIGIN_CERT", path.join(home, "missing-cert.pem"));
    expect(hasCloudflaredCert()).toBe(false);
    const operations: string[] = [];
    const account: CloudflaredAccount = {
      hasCert: () => false,
      login: async () => { operations.push("login"); },
      listTunnels: async () => [],
      createTunnel: async (name) => { operations.push("create"); return { id: tunnelId, name }; },
      routeDns: async () => { operations.push("route"); },
    };
    const result = await provisionNamedTunnel({ workspaceId: "management", workspaceName: "Test", zone: "example.com", account });
    expect(result.fallback).toBe(false);
    expect(operations).toEqual(["login", "create", "route"]);
  });

  it("reports the missing account certificate when an account management command needs it", async () => {
    const home = makeTmpDir("named-management-required"); dirs.push(home);
    vi.stubEnv("TUNNEL_ORIGIN_CERT", path.join(home, "missing-cert.pem"));
    await expect(new ProcessCloudflaredAccount("fixture-cloudflared").listTunnels()).rejects.toThrow(/cloudflared tunnel login/);
  });
});
