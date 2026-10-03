import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import type { TunnelProvider, TunnelStatus, TunnelDoctorReport } from "../src/tunnel/provider.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

function namedProvider(): TunnelProvider & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  let running = false;
  let url: string | null = null;
  const provider = {
    name: "cloudflare-named",
    start: vi.fn(async () => { running = true; url = "https://named.example"; return url; }),
    stop: vi.fn(async () => { running = false; url = null; }),
    restart: vi.fn(async () => "https://named.example"),
    status: (): TunnelStatus => ({ running, url, provider: "cloudflare-named" }),
    getPublicUrl: () => url,
    doctor: async (): Promise<TunnelDoctorReport> => ({ provider: "cloudflare-named", binaryFound: true, binaryPath: "cloudflared", running, url, problems: [] }),
  };
  return provider;
}

async function startNamedBridge(provider: TunnelProvider): Promise<Bridge> {
  const stateDir = isolateStateDir();
  const root = makeTmpDir("public-identity-gate");
  dirs.push(stateDir, root);
  const workspace = new Workspace(root);
  writeTunnelState({ workspaceId: workspace.id, preference: "named", provider: "cloudflare-named",
    tunnelName: "existing-tunnel", tunnelId: "11111111-1111-4111-8111-111111111111", hostname: "named.example" });
  return startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, tunnelProvider: provider });
}

describe("Named Tunnel public identity gate", () => {
  it("rejects a public instance mismatch before marking the tunnel ready or creating a pairing", async () => {
    const provider = namedProvider();
    const bridge = await startNamedBridge(provider);
    const originalFetch = globalThis.fetch.bind(globalThis);
    let publicProbeCount = 0;
    const publicFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://named.example")) {
        publicProbeCount++;
        return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok", workspaceId: bridge.workspace.id, instanceId: "other-replica" }));
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal("fetch", publicFetch);
    try {
      const start = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(start.status).toBe(409);
      expect(await start.json()).toMatchObject({ error: "PUBLIC_INSTANCE_MISMATCH" });
      expect(publicProbeCount).toBe(3);
      expect(provider.stop).toHaveBeenCalledTimes(1);
      expect((await (await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { Authorization: `Bearer ${bridge.adminToken}` },
      })).json()).tunnel).toMatchObject({ running: false, url: null });

      const pairing = await fetch(`${bridge.localBaseUrl()}/admin/pairing`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(pairing.status).toBe(409);
      expect(await pairing.json()).toMatchObject({ error: "NAMED_TUNNEL_DOWN" });
      expect(bridge.pairing.hasActiveSession()).toBe(false);
    } finally { await bridge.close(); }
  });

  it("requires all three uncached public checks to match before pairing", async () => {
    const provider = namedProvider();
    const bridge = await startNamedBridge(provider);
    const originalFetch = globalThis.fetch.bind(globalThis);
    let publicProbeCount = 0;
    const publicFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://named.example")) {
        publicProbeCount++;
        return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok", workspaceId: bridge.workspace.id, instanceId: bridge.instanceId }));
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal("fetch", publicFetch);
    try {
      const start = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(start.status).toBe(200);
      expect(publicProbeCount).toBe(3);
      const pairing = await fetch(`${bridge.localBaseUrl()}/admin/pairing`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(pairing.status).toBe(200);
      expect(publicProbeCount).toBe(6);
      expect(bridge.pairing.hasActiveSession()).toBe(true);
    } finally { await bridge.close(); }
  });
});
