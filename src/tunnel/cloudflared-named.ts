import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import { tunnelProtocolArgs } from "./protocol.js";
import { cloudflaredCredentialPath } from "./cloudflared-paths.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";
import { stopOwnedChildProcess } from "./child-process.js";

const CONNECTED_RE = /registered tunnel connection/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface CloudflaredNamedTunnelOptions {
  tunnelName: string;
  tunnelId?: string;
  hostname: string;
  logger?: Logger;
  binaryOverride?: string;
  startTimeoutMs?: number;
  stopGraceMs?: number;
  stopEscalationMs?: number;
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and its DNS route are provisioned once with cloudflared.
 * This provider only starts and monitors the connector process, so the public
 * URL remains stable across bridge restarts.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private readonly tunnelName: string;
  private readonly tunnelId?: string;
  private readonly hostname: string;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly startTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly stopEscalationMs: number;
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private connected = false;
  private lastError: string | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    const tunnelName = opts.tunnelName.trim();
    if (!tunnelName || tunnelName.length > 128) {
      throw new Error("Named tunnel name must be between 1 and 128 characters");
    }
    this.tunnelName = tunnelName;
    if (opts.tunnelId !== undefined) {
      this.tunnelId = opts.tunnelId.trim();
      if (!cloudflaredCredentialPath(this.tunnelId)) throw new Error("Invalid named tunnel UUID");
    }
    this.hostname = normalizeNamedTunnelHostname(opts.hostname);
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;
    this.startTimeoutMs = opts.startTimeoutMs ?? 45_000;
    this.stopGraceMs = opts.stopGraceMs ?? 5_000;
    this.stopEscalationMs = opts.stopEscalationMs ?? 2_000;
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return `https://${this.hostname}`;
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.connected) return this.publicUrl();
    if (this.starting) return this.starting;
    if (this.child) throw new Error("CLOUDFLARED_STOP_PENDING: previous Named Tunnel child has not exited.");
    const starting = this.startProcess(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startProcess(localPort: number): Promise<string> {
    if (this.child && this.connected) return this.publicUrl();
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }

    const credentialPath = this.tunnelId ? cloudflaredCredentialPath(this.tunnelId) : null;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        bin,
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${localPort}`,
          ...tunnelProtocolArgs(),
          "run",
          ...(credentialPath ? ["--credentials-file", credentialPath] : []),
          this.tunnelId ?? this.tunnelName,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
      this.child = child;
      this.connected = false;
      this.lastError = null;
      let settled = false;
      let failureCleanup: Promise<void> | null = null;

      const finish = (fn: () => void): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        fn();
        return true;
      };
      const fail = (error: Error): Promise<void> => {
        if (failureCleanup) return failureCleanup;
        if (settled) return Promise.resolve();
        settled = true;
        clearTimeout(timeout);
        failureCleanup = (async () => {
          let rejection = error;
          try {
            await stopOwnedChildProcess(child, { graceMs: this.stopGraceMs, escalationMs: this.stopEscalationMs });
          } catch (shutdownError) {
            const detail = shutdownError instanceof Error ? shutdownError.message : String(shutdownError);
            rejection = new Error(`${error.message}; ${detail}`, { cause: error });
          }
          if (this.child === child) {
            if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) this.child = null;
            this.connected = false;
          }
          reject(rejection);
        })();
        return failureCleanup;
      };
      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.lastError = "Named tunnel start timed out";
          void fail(new Error(this.lastError));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (CONNECTED_RE.test(line) && !this.connected) {
            this.connected = true;
            const url = this.publicUrl();
            this.logger.info(`Named tunnel established: ${url}`);
            finish(() => resolve(url));
          }
          if (/\b(error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        void fail(error);
      });
      child.on("exit", (code) => {
        const wasStarting = !this.connected;
        this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
        if (this.child === child) this.child = null;
        this.connected = false;
        if (wasStarting) {
          void fail(new Error(
            `cloudflared exited (code ${code}) before establishing the named tunnel${
              this.lastError ? `: ${this.lastError}` : ""
            }`
          ));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    const child = this.child;
    if (child) {
      await stopOwnedChildProcess(child, { graceMs: this.stopGraceMs, escalationMs: this.stopEscalationMs });
      if (this.child === child) this.child = null;
    }
    this.connected = false;
    await starting?.catch(() => undefined);
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
      startTimeoutMs: this.startTimeoutMs,
    };
  }

  getPublicUrl(): string | null {
    return this.connected ? this.publicUrl() : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("named tunnel process not running");
    if (this.child && !this.connected) problems.push("named tunnel is not connected yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      problems,
    };
  }
}
