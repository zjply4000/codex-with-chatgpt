import { afterEach, describe, expect, it, vi } from "vitest";
import { quickTunnelStartTimeoutMs, tunnelStartRequestTimeoutMs } from "../src/tunnel/timeouts.js";
import { CloudflaredQuickTunnel } from "../src/tunnel/cloudflared.js";

afterEach(() => vi.unstubAllEnvs());

describe("Tunnel start request budget", () => {
  it.each([undefined, "180000", "300000", "invalid", "-1"])(
    "allows the provider to finish before the management request aborts (%s)", (configured) => {
      vi.stubEnv("C2C_TUNNEL_START_TIMEOUT_MS", configured);
      expect(tunnelStartRequestTimeoutMs()).toBeGreaterThan(quickTunnelStartTimeoutMs());
    }
  );
  it("keeps enough time for Named Tunnel startup when Quick startup is disabled", () => {
    vi.stubEnv("C2C_TUNNEL_START_TIMEOUT_MS", "0");
    expect(tunnelStartRequestTimeoutMs()).toBeGreaterThan(45_000);
  });
  it("uses the running provider's budget when the client's environment differs", () => {
    vi.stubEnv("C2C_TUNNEL_START_TIMEOUT_MS", "180000");
    const provider = new CloudflaredQuickTunnel(undefined, "cloudflared");
    vi.stubEnv("C2C_TUNNEL_START_TIMEOUT_MS", undefined);
    expect(tunnelStartRequestTimeoutMs(provider.status().startTimeoutMs)).toBeGreaterThan(180_000);
  });
});
