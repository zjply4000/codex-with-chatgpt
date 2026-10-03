import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { canonicalPathFingerprint, DEFAULT_HOST, DEFAULT_PORT, getStateDir } from "../config/paths.js";
import { appendExecutionRecord, executionRecordSchema, hasExecutionRecord, readExecutionRecords } from "../execution/records.js";
import { MAX_EXECUTION_OUTPUT_INPUT_BYTES, saveExecutionOutput } from "../execution/output.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { acquireBridgeLease } from "./lease.js";
import { assertMaintenanceAccess } from "../process/maintenance.js";
import { probePublicBridge } from "./verify.js";
import { createProcessInspector } from "../process/inspect.js";
import { discoverWorkspaceBridgeProcesses, identifyBridgeProcess, sameBridgePath } from "../process/bridge-process.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      tunnelId: binding.tunnelId,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  instanceId: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function executionDiagnostics(workspaceId: string) {
  const records = readExecutionRecords(workspaceId, Number.MAX_SAFE_INTEGER);
  const latest = records.at(-1) ?? null;
  return {
    stateStoreFingerprint: canonicalPathFingerprint(getStateDir()),
    recordCount: records.length,
    latestTaskId: latest?.taskId ?? null,
    latestIteration: latest?.iteration ?? null,
    latestTimestamp: latest?.timestamp ?? null,
  };
}

const adminExecutionRecordPayloadSchema = executionRecordSchema.omit({ outputId: true, outputAvailable: true }).extend({
  taskId: z.string().min(1).max(256),
  iteration: z.number().int().nonnegative().safe(),
  changedFiles: z.union([z.array(z.string().max(1024)).max(1000), z.number().int().nonnegative().safe()]),
  tests: z.string().max(4000).nullable(),
  exitStatus: z.string().min(1).max(80),
  timestamp: z.string().min(1).max(80),
  executor: z.string().min(1).max(80).optional(),
  notes: z.string().max(400).optional(),
});

const adminExecutionRecordRequestSchema = z.object({
  record: adminExecutionRecordPayloadSchema,
  output: z.object({
    command: z.string().max(200),
    raw: z.string(),
    exitCode: z.number().int().safe().nullable().optional(),
  }).strict().optional(),
}).strict();

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const maintenanceToken = process.env.C2C_BRIDGE_MAINTENANCE_TOKEN;
  assertMaintenanceAccess(workspace.id, maintenanceToken);
  delete process.env.C2C_BRIDGE_MAINTENANCE_TOKEN;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  const instanceId = randomBytes(16).toString("hex");

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok", instanceId });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger,
    bridgeInstanceId: instanceId, executionStoreFingerprint: canonicalPathFingerprint(getStateDir()) }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, async (_req, res) => {
    if (namedTunnelBinding(readTunnelState(workspace.id))) {
      if (!publicBaseUrl || !tunnel.status().running) {
        res.status(409).json({ error: "NAMED_TUNNEL_DOWN", message: "NAMED_TUNNEL_DOWN: refusing to create a pairing session while the configured Named Tunnel is not verified." });
        return;
      }
      const publicIdentity = await probePublicBridge(publicBaseUrl, workspace.id, instanceId, 3);
      if (!publicIdentity.ok) {
        const code = publicIdentity.detail === "PUBLIC_INSTANCE_MISMATCH" ? "PUBLIC_INSTANCE_MISMATCH" : "PUBLIC_INSTANCE_UNVERIFIED";
        res.status(409).json({ error: code,
          message: `${code}: local Bridge instance ${instanceId} does not match the public /health instance; an extra Named Tunnel replica may be active. Run c2c doctor before pairing.` });
        return;
      }
    }
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status().provider === "cloudflare-named" && !publicBaseUrl
        ? { ...tunnel.status(), running: false, url: null, detail: tunnel.status().detail ?? "PUBLIC_INSTANCE_UNVERIFIED" }
        : tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
      instanceId,
      executionDiagnostics: executionDiagnostics(workspace.id),
      authDiagnostics: authStore.diagnostics(),
    });
  });

  app.get("/admin/execution/check", adminGuard, (req, res) => {
    const taskId = req.query.task;
    const iterationText = req.query.iteration;
    if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 256 ||
      typeof iterationText !== "string" || !/^(0|[1-9]\d*)$/.test(iterationText)) {
      res.status(400).json({ error: "INVALID_EXECUTION_QUERY" });
      return;
    }
    const iteration = Number(iterationText);
    if (!Number.isSafeInteger(iteration)) {
      res.status(400).json({ error: "INVALID_EXECUTION_QUERY" });
      return;
    }
    res.json({
      workspaceId: workspace.id,
      taskId,
      iteration,
      exists: hasExecutionRecord(workspace.id, taskId, iteration),
      stateStoreFingerprint: canonicalPathFingerprint(getStateDir()),
    });
  });

  app.post("/admin/execution/record", adminGuard, express.json({ limit: "512kb", strict: true }), (req, res) => {
    try { assertMaintenanceAccess(workspace.id); }
    catch {
      res.status(409).json({ error: "BRIDGE_MAINTENANCE_IN_PROGRESS" });
      return;
    }
    const parsed = adminExecutionRecordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_EXECUTION_RECORD" });
      return;
    }
    const { record, output } = parsed.data;
    if (output && Buffer.byteLength(output.raw, "utf8") > MAX_EXECUTION_OUTPUT_INPUT_BYTES) {
      res.status(413).json({ error: "EXECUTION_OUTPUT_TOO_LARGE" });
      return;
    }
    let outputId: number | undefined;
    let outputAvailable: boolean | undefined;
    if (output) {
      const saved = saveExecutionOutput(workspace.id, {
        command: output.command,
        raw: output.raw,
        exitCode: output.exitCode ?? null,
        taskId: record.taskId,
        iteration: record.iteration,
      });
      outputId = saved.id;
      outputAvailable = saved.allowed;
    }
    appendExecutionRecord(workspace.id, { ...record, outputId, outputAvailable });
    res.status(201).json({
      ok: true,
      workspaceId: workspace.id,
      taskId: record.taskId,
      iteration: record.iteration,
      exists: hasExecutionRecord(workspace.id, record.taskId, record.iteration),
      outputId,
      outputAvailable,
      stateStoreFingerprint: canonicalPathFingerprint(getStateDir()),
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    void (async () => {
      try {
        const url = await tunnel.start(port);
        if (tunnel.status().provider === "cloudflare-named") {
          const identity = await probePublicBridge(url, workspace.id, instanceId, 3);
          if (!identity.ok) {
            const code = identity.detail === "PUBLIC_INSTANCE_MISMATCH" ? "PUBLIC_INSTANCE_MISMATCH" : "PUBLIC_INSTANCE_UNVERIFIED";
            throw Object.assign(new Error(`${code}: local Bridge instance ${instanceId} did not match all three uncached public probes; another Named Tunnel replica may be active.`), { code });
          }
        }
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      } catch (error) {
        publicBaseUrl = null;
        const message = error instanceof Error ? error.message : String(error);
        let cleanupFailed = false;
        try { await tunnel.stop(); }
        catch (stopError) {
          cleanupFailed = true;
          logger.error(`Owned tunnel did not stop after failed startup: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
        }
        const code = message.startsWith("PUBLIC_INSTANCE_MISMATCH") ? "PUBLIC_INSTANCE_MISMATCH"
          : message.startsWith("PUBLIC_INSTANCE_UNVERIFIED") ? "PUBLIC_INSTANCE_UNVERIFIED" : "tunnel_failed";
        const finalMessage = cleanupFailed ? `${message} CLOUDFLARED_STOP_FAILED: restart is blocked until the owned child exits.` : message;
        logger.error(`Tunnel start failed: ${finalMessage}`);
        res.status(code === "tunnel_failed" ? 500 : 409).json({ error: code, message: finalMessage });
      }
    })();
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    }).catch((error: Error) => {
      res.status(500).json({ error: "CLOUDFLARED_STOP_FAILED", message: error.message });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0)).catch((error: Error) => {
        logger.error(`Bridge shutdown blocked because its owned tunnel is still running: ${error.message}`);
        process.exitCode = 1;
      });
    }, 100);
  });

  const releaseBridgeLease = opts.persistRuntime === false
    ? () => {}
    : await acquireBridgeLease(workspace.id, instanceId);
  let listening: { server: Server; port: number };
  try {
    const self = identifyBridgeProcess({ pid: process.pid, parentPid: process.ppid, executable: process.execPath,
      argv: process.argv, startId: "startup", cwd: process.cwd() });
    if (opts.persistRuntime !== false && self.verified && self.workspaceRoot && sameBridgePath(self.workspaceRoot, workspace.root)) {
      const snapshot = await createProcessInspector().snapshot(opts.port ?? DEFAULT_PORT);
      const existing = await discoverWorkspaceBridgeProcesses(snapshot, workspace.root, {
        assumedPort: opts.port ?? DEFAULT_PORT,
        excludePids: [process.pid],
      });
      if (existing.blockers.length) throw new Error(`BRIDGE_IDENTITY_UNVERIFIED: ${existing.blockers.join(" ")}`);
      if (existing.bridges.length) throw new Error("DUPLICATE_BRIDGE: Another verified Bridge already serves this workspace.");
    }
    listening = await listen(app, host, opts.port ?? DEFAULT_PORT);
  } catch (error) {
    releaseBridgeLease();
    throw error;
  }
  const { server, port } = listening;
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
      instanceId,
    };
    writeRuntimeState(state);
  };
  try {
    persistRuntime();
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseBridgeLease();
    throw error;
  }

  let closed = false;
  let closing: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    if (closing) return closing;
    closing = (async () => {
      await tunnel.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
      releaseBridgeLease();
      closed = true;
      logger.info("Bridge stopped");
    })();
    try { await closing; }
    finally { closing = null; }
  };

  return {
    workspace,
    port,
    host,
    adminToken,
    instanceId,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
