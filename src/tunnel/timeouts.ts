export function quickTunnelStartTimeoutMs(): number {
  const raw = process.env.C2C_TUNNEL_START_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90_000;
}

export function tunnelStartRequestTimeoutMs(providerTimeoutMs?: number): number {
  // The provider's timer starts after the admin request arrives. Keep enough
  // headroom to receive its result, including a configured longer DNS wait.
  const startTimeout = typeof providerTimeoutMs === "number" && Number.isFinite(providerTimeoutMs) && providerTimeoutMs >= 0
    ? providerTimeoutMs : quickTunnelStartTimeoutMs();
  return Math.max(90_000, startTimeout + 10_000);
}
