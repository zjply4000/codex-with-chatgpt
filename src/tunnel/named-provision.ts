import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { cloudflaredCredentialPath, hasCloudflaredCert } from "./cloudflared-paths.js";
export { cloudflaredCertPath, cloudflaredCredentialPath, hasCloudflaredCert } from "./cloudflared-paths.js";
import { findBinary } from "./detect.js";
import { suggestedNamedHostname } from "./hostname.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";
import {
  NAMED_FALLBACK_MESSAGE,
  writeTunnelState,
  type TunnelState,
} from "./state.js";

const TUNNEL_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TUNNEL_ID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

export type NamedTunnelCredentialStatus =
  | "missing_tunnel_id"
  | "missing_credentials"
  | "unreadable_credentials"
  | "invalid_credentials"
  | "mismatched_credentials"
  | "ready";

export interface NamedTunnelCredentialCheck {
  status: NamedTunnelCredentialStatus;
  /** Kept for local diagnostics and tests; callers must not serialize its contents. */
  credentialPath: string | null;
}

export interface ListedTunnel {
  id: string;
  name: string;
}

export interface CloudflaredAccount {
  hasCert(): boolean;
  login(): Promise<void>;
  listTunnels(): Promise<ListedTunnel[]>;
  createTunnel(name: string): Promise<ListedTunnel>;
  routeDns(tunnelName: string, hostname: string): Promise<void>;
}

/**
 * Check UUID-specific run credentials without exposing their contents.
 * Account cert.pem authorizes management commands, not this run operation.
 * Inspection is read-only; credential repair requires an explicit action.
 */
export function inspectNamedTunnelCredentials(tunnelId?: string, platform: NodeJS.Platform = process.platform): NamedTunnelCredentialCheck {
  const credentialPath = cloudflaredCredentialPath(tunnelId ?? "", platform);
  if (!credentialPath) return { status: "missing_tunnel_id", credentialPath: null };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(credentialPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === "ENOENT" || code === "ENOTDIR" ? "missing_credentials" : "unreadable_credentials",
      credentialPath,
    };
  }
  if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) {
    return { status: "unreadable_credentials", credentialPath };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(credentialPath, "utf8");
  } catch {
    return { status: "unreadable_credentials", credentialPath };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { status: "invalid_credentials", credentialPath };
    const record = parsed as { TunnelID?: unknown; TunnelSecret?: unknown };
    if (
      typeof record.TunnelID !== "string" ||
      !TUNNEL_ID_FULL_RE.test(record.TunnelID) ||
      typeof record.TunnelSecret !== "string" ||
      record.TunnelSecret.trim().length === 0
    ) {
      return { status: "invalid_credentials", credentialPath };
    }
    if (record.TunnelID.toLowerCase() !== tunnelId!.trim().toLowerCase()) {
      return { status: "mismatched_credentials", credentialPath };
    }
    return { status: "ready", credentialPath };
  } catch {
    return { status: "invalid_credentials", credentialPath };
  }
}

export function namedTunnelCredentialRepairMessage(status: NamedTunnelCredentialStatus, platform: NodeJS.Platform = process.platform): string {
  switch (status) {
    case "missing_credentials": {
      const location = platform === "win32" ? "%USERPROFILE%\\.cloudflared\\<TUNNEL-UUID>.json" : "~/.cloudflared/<TUNNEL-UUID>.json";
      const destination = platform === "win32" ? location : "$HOME/.cloudflared/<TUNNEL-UUID>.json";
      return `固定域名缺少 Tunnel 凭据文件。请从管理端恢复对应的 UUID.json（默认位置 ${location}；设置了 TUNNEL_CRED_FILE 时恢复该指定文件）；如需重新获取，在有账号证书的机器运行 cloudflared tunnel token --cred-file "${destination}" <TUNNEL-UUID>，完成后再运行 c2c doctor。`;
    }
    case "unreadable_credentials":
      return "固定域名的 Tunnel 凭据文件不可读或过大。请恢复正确的 UUID.json 文件权限和内容，再运行 c2c doctor。";
    case "invalid_credentials":
      return "固定域名的 Tunnel 凭据文件不是有效的本地 Tunnel JSON。请恢复正确文件，再运行 c2c doctor。";
    case "mismatched_credentials":
      return "固定域名的 Tunnel 凭据与当前保存的 Tunnel ID 不匹配。请恢复对应的 UUID.json 文件，再运行 c2c doctor。";
    case "missing_tunnel_id":
      return "固定域名状态缺少 Tunnel ID。请运行 c2c setup 重新保存 Named Tunnel 状态。";
    case "ready":
      return "固定域名凭据已就绪。";
  }
}

export function parseTunnelList(output: string): ListedTunnel[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as { tunnels?: unknown }).tunnels;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const record = row as { id?: unknown; name?: unknown };
        if (typeof record.id !== "string" || typeof record.name !== "string") return [];
        return [{ id: record.id, name: record.name }];
      });
    } catch {
      // fall through to the table parser
    }
  }
  const found: ListedTunnel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.match(TUNNEL_ID_RE)?.[0];
    if (!id) continue;
    const after = line.slice(line.indexOf(id) + id.length).trim();
    const name = after.split(/\s+/)[0];
    if (name && name !== "NAME") found.push({ id, name });
  }
  return found;
}

export function parseCreatedTunnel(output: string, name: string): ListedTunnel | null {
  const id = output.match(TUNNEL_ID_RE)?.[0];
  return id ? { id, name } : null;
}

export function isBenignRouteError(message: string): boolean {
  return /already exists|duplicate|exists as a cname/i.test(message);
}

export class ProcessCloudflaredAccount implements CloudflaredAccount {
  constructor(private readonly binaryOverride?: string) {}

  private binary(): string {
    const bin = this.binaryOverride ?? findBinary("cloudflared");
    if (!bin) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    return bin;
  }

  hasCert(): boolean {
    return hasCloudflaredCert();
  }

  async login(): Promise<void> {
    if (this.hasCert()) return;
    const bin = this.binary();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["tunnel", "login"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Cloudflare login timed out"));
      }, LOGIN_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (this.hasCert()) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Cloudflare login did not finish${code !== 0 ? ` (exit ${code})` : ""}${
              output.trim() ? `: ${output.trim().slice(0, 400)}` : ""
            }`
          )
        );
      });
    });
  }

  async listTunnels(): Promise<ListedTunnel[]> {
    const json = this.run(["tunnel", "list", "--output", "json"]);
    if (json.ok) {
      const parsed = parseTunnelList(json.stdout || json.stderr);
      if (parsed.length > 0 || (json.stdout || json.stderr).trim().startsWith("[")) return parsed;
    }
    const table = this.run(["tunnel", "list"]);
    if (!table.ok) throw new Error(table.stderr || table.stdout || "Unable to list Cloudflare tunnels");
    return parseTunnelList(`${table.stdout}\n${table.stderr}`);
  }

  async createTunnel(name: string): Promise<ListedTunnel> {
    const existing = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
    if (existing) return existing;
    const result = this.run(["tunnel", "create", name]);
    const created = parseCreatedTunnel(`${result.stdout}\n${result.stderr}`, name);
    if (created) return created;
    if (/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      const again = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
      if (again) return again;
    }
    throw new Error(result.stderr || result.stdout || `Unable to create tunnel ${name}`);
  }

  async routeDns(tunnelName: string, hostname: string): Promise<void> {
    const result = this.run(["tunnel", "route", "dns", tunnelName, hostname]);
    if (result.ok || isBenignRouteError(`${result.stdout}\n${result.stderr}`)) return;
    throw new Error(result.stderr || result.stdout || `Unable to route ${hostname}`);
  }

  private run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    if (!this.hasCert()) {
      throw new Error("NAMED_TUNNEL_MANAGEMENT_MISSING_ACCOUNT_CERTIFICATE: Tunnel 管理操作需要账号证书。请运行 cloudflared tunnel login；运行已有 UUID Tunnel 不需要此证书。");
    }
    const result = spawnSync(this.binary(), args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  }
}

export interface ProvisionNamedResult {
  ok: boolean;
  state: TunnelState;
  fallback: boolean;
  userMessage?: string;
  error?: string;
}

export async function provisionNamedTunnel(opts: {
  workspaceId: string;
  workspaceName: string;
  zone: string;
  hostname?: string;
  account?: CloudflaredAccount;
}): Promise<ProvisionNamedResult> {
  const account = opts.account ?? new ProcessCloudflaredAccount();
  let hostname: string;
  try {
    hostname = opts.hostname
      ? normalizeNamedTunnelHostname(opts.hostname)
      : suggestedNamedHostname(opts.zone, opts.workspaceName, opts.workspaceId);
  } catch (error) {
    return fallbackState(opts.workspaceId, "invalid_hostname", (error as Error).message);
  }

  const tunnelName = `c2c-${opts.workspaceId}`;
  try {
    if (!account.hasCert()) await account.login();
    const tunnel = await account.createTunnel(tunnelName);
    await account.routeDns(tunnel.name, hostname);
    const state = writeTunnelState({
      workspaceId: opts.workspaceId,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: tunnel.name,
      tunnelId: tunnel.id,
      hostname,
      zone: normalizeNamedTunnelHostname(opts.zone),
      configuredAt: new Date().toISOString(),
    });
    return { ok: true, state, fallback: false };
  } catch (error) {
    return fallbackState(opts.workspaceId, "provision_failed", (error as Error).message);
  }
}

export function chooseQuickTunnel(workspaceId: string, fallbackReason?: string): TunnelState {
  return writeTunnelState({
    workspaceId,
    preference: "quick",
    askedAt: new Date().toISOString(),
    provider: "cloudflare-quick",
    fallbackReason,
  });
}

function fallbackState(workspaceId: string, reason: string, error: string): ProvisionNamedResult {
  const state = chooseQuickTunnel(workspaceId, reason);
  return {
    ok: true,
    state,
    fallback: true,
    userMessage: NAMED_FALLBACK_MESSAGE,
    error,
  };
}
