import { spawnSync } from "node:child_process";
import { hasCloudflaredCert } from "./cloudflared-paths.js";
import { findBinary } from "./detect.js";

const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RemoteConnectorInspection {
  available: boolean;
  connectorCount: number | null;
  detail: string;
}

/** Parse only connector row count; never return IDs or origin IPs. */
export function parseTunnelInfoConnectorCount(output: string): number | null {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*CONNECTOR ID\s+/i.test(line));
  if (header < 0) return null;
  let count = 0;
  for (const line of lines.slice(header + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (count > 0) break;
      continue;
    }
    if (CONNECTOR_ID_RE.test(trimmed.split(/\s+/)[0] ?? "")) count++;
    else if (count > 0) break;
  }
  return count;
}

/** Read-only remote connector count when local management credentials permit it. */
export function inspectRemoteTunnelConnectors(
  tunnelId: string,
  options: { binaryOverride?: string; timeoutMs?: number; disabled?: boolean } = {}
): RemoteConnectorInspection {
  if (options.disabled || process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test") {
    return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
  }
  if (!TUNNEL_ID_RE.test(tunnelId)) {
    return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
  }
  if (!hasCloudflaredCert()) {
    return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
  }
  const binary = options.binaryOverride ?? findBinary("cloudflared");
  if (!binary) return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
  try {
    const result = spawnSync(binary, ["tunnel", "info", tunnelId], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      windowsHide: true,
    });
    if (result.status !== 0) return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
    const connectorCount = parseTunnelInfoConnectorCount(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (connectorCount === null) return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
    return {
      available: true,
      connectorCount,
      detail: connectorCount > 1 ? `MULTIPLE_REMOTE_TUNNEL_CONNECTORS: ${connectorCount}` : `remote connectors: ${connectorCount}`,
    };
  } catch {
    return { available: false, connectorCount: null, detail: "REMOTE_CONNECTOR_INFO_UNAVAILABLE" };
  }
}
