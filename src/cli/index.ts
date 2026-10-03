import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { BRIDGE_RUNTIME_REPAIR_MESSAGE, findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, BridgeAdminUnavailableError, ensureBridge, restartBridge, stopBridge } from "../process/daemon.js";
import { recoverBridge } from "../process/recover.js";
import { createProcessInspector } from "../process/inspect.js";
import { discoverWorkspaceBridgeProcesses } from "../process/bridge-process.js";
import { bridgeRuntimeMismatchGuidance } from "./doctor-guidance.js";
import { describeBridgeProcesses, describeCloudflaredProcesses, inspectLocalCloudflared } from "../process/diagnostics.js";
import { probeMcp, probePublicBridge, type BridgeAdminInfo as AdminInfo } from "../bridge/verify.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { inspectRemoteTunnelConnectors } from "../tunnel/remote-connectors.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  inspectNamedTunnelCredentials,
  namedTunnelCredentialRepairMessage,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { canonicalPathFingerprint, DEFAULT_PORT, getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  adoptProjectChat,
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { hasExecutionRecord } from "../execution/records.js";
import { readExecutionStoreBinding, writeExecutionStoreBinding } from "../execution/store-binding.js";
import { checkForUpdates, formatUpdateCheck } from "../update/check.js";
import { importMediaAsset } from "../media/import.js";
import { tunnelStartRequestTimeoutMs } from "../tunnel/timeouts.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  let namedGatePassed = false;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", tunnelStartRequestTimeoutMs(info.tunnel.startTimeoutMs));
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
    namedGatePassed = info.tunnel.provider === "cloudflare-named";
  }
  if (info.publicUrl && info.tunnel.provider === "cloudflare-named" && !namedGatePassed) {
    const identity = await probePublicBridge(info.publicUrl, info.workspaceId, runtime.instanceId, 3);
    if (!identity.ok) {
      throw new Error(`${identity.detail}: public /health does not consistently identify the local Bridge; another Named Tunnel replica may be active.`);
    }
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

/** Machine-wide commands ignore `-w` so a Skill that always passes it cannot crash them. */
function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    let shutdownPending = false;
    const shutdown = (): void => {
      if (shutdownPending) return;
      shutdownPending = true;
      void bridge.close().then(() => process.exit(0)).catch((error: Error) => {
        logger.error(`Bridge shutdown remains active because an owned child did not exit: ${error.message}`);
        shutdownPending = false;
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const restarted = await restartBridge(root, { tunnel: opts.tunnel });
      if (!restarted.runtime) throw new Error("Bridge restart did not return a verified runtime.");
      const info = await adminFetch<AdminInfo>(restarted.runtime, "GET", "/admin/info");
      const mcpUrl = restarted.publicUrl ? `${restarted.publicUrl}/mcp` : info.publicUrl ? `${info.publicUrl}/mcp` : null;
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program.command("bridge").description("Controlled Bridge maintenance")
  .command("recover")
  .description("Safely retire verified stale Bridge processes and restore this workspace's connection")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--dry-run", "read-only process verification and recovery plan", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; dryRun: boolean; json: boolean }) => {
    try {
      const result = await recoverBridge(resolveWorkspace(opts.workspace), { dryRun: opts.dryRun });
      if (opts.json) say(JSON.stringify(result));
      else if (result.message && !opts.dryRun) say(result.message);
      else {
        if (result.message) say(result.message);
        say(`Workspace: ${result.plan.workspace}`);
        say(`Bridge: ${result.previousState}`);
        if (result.plan.runtime) say(`Saved runtime: PID ${result.plan.runtime.pid}, port ${result.plan.runtime.port}`);
        say(`Verified Bridge PIDs: ${result.plan.bridges.map(bridge => bridge.pid).join(", ") || "none"}`);
        for (const bridge of result.plan.bridges) say(`Verified PID ${bridge.pid}: ${bridge.executable} — ${bridge.summary}`);
        say(`Descendants: ${result.plan.descendantCount}`);
        say(`Tunnel: ${result.plan.tunnel.mode}${result.plan.tunnel.hostname ? ` (${result.plan.tunnel.hostname})` : ""}`);
        if (opts.dryRun) say(`Phases: ${result.plan.phases.join(" → ")}; safe to recover: ${result.canRecover}`);
        else if (result.ok) check("Bridge recovery verified; existing authorization and session preserved");
        if (result.connectorRepairNeeded) say("Quick Tunnel address changed; connector endpoint repair is needed after doctor is green.");
        if (result.error) cross(result.error);
      }
      if (!result.ok) process.exitCode = 1;
    } catch (error) { handleCliError(error, opts.json); }
  });

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string; state?: string; reason?: string;
      available?: boolean; connectorCount?: number | null }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    let localCloudflaredIssue: string | null = null;
    let bridgeRepair: { needed: boolean; reason?: string; automatic?: false; userMessage?: string } = { needed: false };
    const requireBridgeRuntimeRepair = (reason: "stale_runtime" | "admin_unavailable"): void => {
      runtime = null;
      bridgeUnknown = true;
      report.bridge = { ok: false, state: "unknown", reason, detail: `运行记录无法验证（${reason}），未自动修复` };
      bridgeRepair = { needed: true, reason, automatic: false, userMessage: BRIDGE_RUNTIME_REPAIR_MESSAGE };
    };
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      const embeddedParentBridge = observation.state === "healthy" && observation.runtime.pid === process.ppid;
      let discovery: Awaited<ReturnType<typeof discoverWorkspaceBridgeProcesses>> | null = null;
      let processSnapshot: Awaited<ReturnType<ReturnType<typeof createProcessInspector>["snapshot"]>> | null = null;
      let processInspectionFailed = false;
      if (embeddedParentBridge) {
        report.bridgeProcesses = { ok: true, detail: "Bridge is hosted by the invoking parent process; no daemon duplicate was found." };
      } else {
        try {
          processSnapshot = await createProcessInspector().snapshot(observation.runtime?.port ?? DEFAULT_PORT);
          discovery = await discoverWorkspaceBridgeProcesses(processSnapshot, workspace.root, {
            assumedPort: observation.runtime?.port ?? DEFAULT_PORT,
            runtimePid: observation.runtime?.pid,
          });
          if (discovery.blockers.length) {
            report.bridgeProcesses = { ok: false, detail: `BRIDGE_IDENTITY_UNVERIFIED: ${discovery.blockers.join(" ")}` };
            processInspectionFailed = true;
          } else {
            report.bridgeProcesses = describeBridgeProcesses(discovery.bridges);
          }
          const tunnelState = readTunnelState(workspace.id);
          if (tunnelState.tunnelId) {
            const cloudflared = inspectLocalCloudflared(processSnapshot, tunnelState.tunnelId, workspace.root, discovery.bridges);
            const cloudflaredReport = describeCloudflaredProcesses(cloudflared);
            report.cloudflared = cloudflaredReport;
            if (!cloudflaredReport.ok) localCloudflaredIssue = cloudflaredReport.detail;
          }
        } catch {
          report.bridgeProcesses = { ok: false, detail: "LOCAL_PROCESS_INSPECTION_UNAVAILABLE: cannot verify local Bridge singleton." };
          processInspectionFailed = true;
        }
      }

      const duplicateBridge = Boolean(discovery && discovery.bridges.length > 1);
      if (duplicateBridge) {
        bridgeUnknown = true;
        report.bridge = { ok: false, state: "duplicate", reason: "DUPLICATE_BRIDGE", detail: report.bridgeProcesses?.detail };
        bridgeRepair = { needed: true, reason: "DUPLICATE_BRIDGE", automatic: false,
          userMessage: "Multiple verified Bridge processes serve this workspace. No process was stopped; run c2c restart after reviewing the exact process identities." };
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, state: "unknown", reason: observation.reason, detail: `状态无法确认（${observation.reason}），未自动修复` };
        if (observation.reason === "stale_runtime") requireBridgeRuntimeRepair(observation.reason);
      } else if (processInspectionFailed) {
        bridgeUnknown = true;
        report.bridge = { ok: false, state: "unknown", reason: "PROCESS_IDENTITY_UNVERIFIED", detail: report.bridgeProcesses?.detail };
        bridgeRepair = { needed: true, reason: "PROCESS_IDENTITY_UNVERIFIED", automatic: false,
          userMessage: "Local Bridge process identity could not be verified. No Bridge or tunnel process was changed." };
      } else if (observation.state === "healthy") {
        const candidate = discovery?.bridges[0];
        const runtimeMatches = embeddedParentBridge || Boolean(candidate && candidate.record.pid === observation.runtime.pid &&
          candidate.port === observation.runtime.port && candidate.instanceId === observation.runtime.instanceId);
        if (runtimeMatches) runtime = observation.runtime;
        else {
          bridgeUnknown = true;
          report.bridge = { ok: false, state: "unknown", reason: "BRIDGE_IDENTITY_UNVERIFIED", detail: "Healthy runtime does not match a verified local Bridge listener." };
          bridgeRepair = { needed: true, reason: "BRIDGE_IDENTITY_UNVERIFIED", automatic: false,
            userMessage: "The runtime health endpoint is not owned by a verified Bridge process. No repair was attempted." };
        }
      } else if (discovery?.bridges.length) {
        bridgeUnknown = true;
        const savedEndpoint = readLastEndpoint(workspace.id);
        const hasConfiguredTunnel = readTunnelState(workspace.id).provider === "cloudflare-named" || Boolean(savedEndpoint?.publicUrl);
        const guidance = bridgeRuntimeMismatchGuidance(workspace.root, hasConfiguredTunnel);
        report.bridge = { ok: false, state: "duplicate", reason: "DUPLICATE_BRIDGE", detail: "运行记录与当前 Bridge 不匹配" };
        bridgeRepair = { needed: true, reason: "DUPLICATE_BRIDGE", automatic: false,
          userMessage: guidance };
        report.tunnel = { ok: false, detail: "Bridge 状态未确认，跳过 Tunnel 检查" };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      } else {
        report.bridge = { ok: false, state: "stopped", reason: observation.reason, detail: "未运行" };
      }
      if (runtime) report.bridge = { ok: true, state: "healthy", detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      report.mcp = await probeMcp(runtime.port);
      report.oauth = { ok: report.mcp.ok };
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    if (tunnelState?.provider === "cloudflare-named" && tunnelState.tunnelId) {
      const remote = inspectRemoteTunnelConnectors(tunnelState.tunnelId);
      report.remoteTunnelConnectors = { ok: true, available: remote.available,
        connectorCount: remote.connectorCount, detail: remote.detail };
    }
    // Existing UUID tunnels need run credentials only. Account certificates
    // belong to explicit provisioning/account management, never this gate.
    const namedCredential = namedReady ? inspectNamedTunnelCredentials(tunnelState?.tunnelId) : null;
    const namedCredentialFailure = Boolean(namedCredential && namedCredential.status !== "ready");
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime && localCloudflaredIssue) {
      report.tunnel = { ok: false, detail: localCloudflaredIssue };
      if (namedReady) namedRepair = { needed: true,
        userMessage: "本地 cloudflared 归属不唯一；doctor 不会清理远端 replica。先安全检查本机进程树，再重新运行 doctor。" };
    } else if (runtime) {
      try {
        let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
        if (namedReady && !namedCredentialFailure && opts.fix && info.tunnel.provider !== "cloudflare-named") {
          await stopBridge(root);
          await new Promise((resolve) => setTimeout(resolve, 400));
          try {
            runtime = (await ensureBridge(root)).runtime;
            info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
            results.push("已切换到固定域名连接");
          } catch (error) {
            if (error instanceof BridgeAdminUnavailableError) throw error;
            report.tunnel = { ok: false, detail: (error as Error).message };
          }
        }
        const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
        let currentUrl = info.publicUrl ?? info.tunnel.url;
        let healthy = false;
        if (currentUrl) {
          const publicProbe = await probePublicBridge(currentUrl, workspace!.id, runtime.instanceId, namedReady ? 3 : 1);
          healthy = publicProbe.ok;
          if (!publicProbe.ok && publicProbe.detail?.startsWith("PUBLIC_INSTANCE")) {
            report.tunnel = { ok: false, detail: publicProbe.detail };
          }
        }

        if ((!currentUrl || !healthy) && !namedCredentialFailure && opts.fix && (expectedPublic || info.tunnel.running)) {
          try {
            const binaries = detectTunnelBinaries();
            if (!binaries.cloudflared) {
              report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
            } else {
              const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", tunnelStartRequestTimeoutMs(info.tunnel.startTimeoutMs));
              if (started.url) {
                const previousUrl = lastEndpoint?.publicUrl;
                currentUrl = started.url;
                healthy = true;
                info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
                const sameAddress =
                  previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
                results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
              }
            }
          } catch (error) {
            if (error instanceof BridgeAdminUnavailableError) throw error;
            report.tunnel = { ok: false, detail: (error as Error).message };
          }
        }

        if (namedCredentialFailure && namedCredential) {
          report.tunnel = {
            ok: false,
            detail: `NAMED_TUNNEL_CREDENTIAL_${namedCredential.status.toUpperCase()}`,
          };
          namedRepair = {
            needed: true,
            userMessage: namedTunnelCredentialRepairMessage(namedCredential.status),
          };
        } else if (currentUrl && healthy) {
          report.tunnel = { ok: true, detail: currentUrl };
          const nextMcp = mcpUrlFromPublic(currentUrl);
          const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
          const boundName = nextMcp
            ? persistWorkspaceEndpoint({
                workspaceId: info.workspaceId,
                workspaceName: info.workspaceName,
                port: runtime.port,
                publicUrl: currentUrl,
                mcpUrl: nextMcp,
                previous: lastEndpoint,
              })
            : connectorName;
          chatgptRepair = {
            ...chatgptRepair,
            needed: action === "update",
            reason: action === "update" ? "address_reclaimed" : undefined,
            connectorAction: action,
            connectorName: boundName,
            userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
            mcpUrl: nextMcp,
            previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
          };
          if (action === "update") {
            results.push(`安全连接地址已更换，需要更新「${boundName}」`);
          }
        } else if (namedReady) {
          report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
          namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
        } else if (expectedPublic) {
          report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
          chatgptRepair = {
            ...chatgptRepair,
            needed: true,
            reason: "address_reclaimed",
            connectorAction: "update",
            connectorName,
            userMessage: reclaimUserMessage(connectorName),
            mcpUrl: null,
          };
        } else if (!currentUrl) {
          report.tunnel = { ok: true, detail: "未启用（本地模式）" };
        } else {
          report.tunnel = { ok: false, detail: "公网地址无法访问" };
        }
      } catch (error) {
        requireBridgeRuntimeRepair(error instanceof BridgeAdminUnavailableError ? error.reason : "admin_unavailable");
        report.tunnel = { ok: false, detail: "Bridge 管理权限无法验证，未执行连接器修复" };
      }
    } else if (namedCredentialFailure && namedCredential) {
      report.tunnel = {
        ok: false,
        detail: `NAMED_TUNNEL_CREDENTIAL_${namedCredential.status.toUpperCase()}`,
      };
      namedRepair = {
        needed: bridgeRepair.reason !== "stale_runtime",
        userMessage: namedTunnelCredentialRepairMessage(namedCredential.status),
      };
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, bridgeRepair, chatgptRepair, namedRepair }));
      const hasFailures =
        Object.values(report).some((value) => !value.ok) || bridgeRepair.needed || chatgptRepair.needed || namedRepair.needed;
      if (hasFailures) process.exitCode = 1;
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      remoteTunnelConnectors: "Remote Tunnel connectors",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (bridgeRepair.needed && bridgeRepair.userMessage) {
      say(bridgeRepair.userMessage);
      say("");
    }
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      bridgeRepair.needed
        ? "本地运行记录需要维护；当前连接未被重启或重建。"
        : allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，还需要在 ChatGPT 删除并重新添加该连接。"
          : namedRepair.needed
            ? "固定域名需要先按上面的诊断提示处理。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(
  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

acceptUnusedWorkspaceOption(
  program
    .command("update-check")
    .description("Safely check the current branch's configured upstream (daily network cache)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { force: boolean; json: boolean }) => {
    const result = checkForUpdates({ checkout: repoRoot, force: opts.force });
    if (opts.json) say(JSON.stringify({ version: VERSION, ...result }));
    else say(formatUpdateCheck(result));
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
    } else {
      say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
      if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
      if (saved.title) say(`会话：${saved.title}`);
      if (saved.url) say(`对话：${saved.url}`);
      if (saved.connectorName) say(`连接器：${saved.connectorName}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
        );
      }
    }
  });

// ---------------------------------------------------------------- generated media handoff

const assetCmd = program
  .command("asset")
  .description("Safely hand downloaded media into the current workspace");

assetCmd
  .command("import", { isDefault: true })
  .description("Validate and copy a downloaded image or video into the workspace")
  .requiredOption("--from <path>", "downloaded source file")
  .requiredOption("--to <path>", "new workspace-relative destination")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { from: string; to: string; workspace?: string; json: boolean }) => {
    try {
      const result = await importMediaAsset({
        workspaceRoot: resolveWorkspace(opts.workspace),
        sourcePath: opts.from,
        destinationPath: opts.to,
      });
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else check(`媒体已导入：${result.destinationPath}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action((opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("adopt")
  .description("Adopt an existing chat in the bound Project as context for a new task")
  .option("-w, --workspace <path>")
  .requiredOption("--url <url>", "existing ChatGPT Project chat URL (…/g/<project>/c/<chat>)")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; url: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const saved = adoptProjectChat(readSession(workspace.id), opts.url);
      writeSession(workspace.id, saved);
      if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation: resolveConversation(saved) }));
      else check("已接管已有 Project 对话上下文，旧任务状态已清除，请从新的 INIT 开始");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT developer mode and setup choice for this machine");

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("get", { isDefault: true })
    .description("Show remembered ChatGPT setup choices (not per workspace)")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
  });

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("set")
    .description("Save a ChatGPT setup choice for this machine")
    .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
    .option("--setup-mode <mode>", "auto (preview) or manual")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("已记住开发人员模式已开启");
      if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
      if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record an execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--executor <id>", "id of the executor that ran this iteration, e.g. codex")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(async (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      executor?: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      const record = {
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        executor: opts.executor?.slice(0, 80),
        notes: opts.notes?.slice(0, 400),
      };
      const output = opts.command && rawOutput !== undefined
        ? { command: opts.command, raw: rawOutput, exitCode: opts.exitCode ?? null }
        : undefined;
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state !== "healthy") {
        throw new Error(`BRIDGE_EXECUTION_STORE_UNAVAILABLE: cannot verify the active Bridge for workspace ${workspace.id} (${observation.state === "unknown" ? observation.reason : observation.reason}).`);
      }
      const saved = await adminFetch<{
        ok: boolean; workspaceId: string; taskId: string; iteration: number; exists: boolean;
        outputId?: number; outputAvailable?: boolean; stateStoreFingerprint: string;
      }>(observation.runtime, "POST", "/admin/execution/record", 60_000, undefined, { record, output });
      if (!saved.ok || saved.workspaceId !== workspace.id || saved.taskId !== opts.task ||
        saved.iteration !== opts.iteration || !saved.exists) {
        throw new Error("BRIDGE_EXECUTION_RECORD_UNVERIFIED: Bridge did not confirm the exact recorded task and iteration.");
      }
      writeExecutionStoreBinding(workspace.id, saved.stateStoreFingerprint);
      if (saved.outputId !== undefined && !saved.outputAvailable) check("已记录 Bridge execution 摘要（输出未对 ChatGPT 开放）");
      else if (saved.outputId !== undefined) check("已记录 Bridge execution 摘要与输出");
      else check("已记录执行摘要");
      } catch (error) {
        handleCliError(error, false);
      }
  });

program
  .command("record-check", { hidden: true })
  .description("Verify an execution record exists in the formal workspace store")
  .requiredOption("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace: string; task: string; iteration: number; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const configuredStateDirFingerprint = canonicalPathFingerprint(getStateDir());
    const result: Record<string, unknown> = {
      ok: false,
      workspaceId: workspace.id,
      taskId: opts.task,
      iteration: opts.iteration,
      configuredStateDirFingerprint,
    };
    try {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state !== "healthy") {
        throw new Error(`BRIDGE_EXECUTION_CHECK_UNAVAILABLE: ${observation.state === "unknown" ? observation.reason : observation.reason}`);
      }
      const bridgeCheck = await adminFetch<{
        workspaceId: string; taskId: string; iteration: number; exists: boolean; stateStoreFingerprint: string;
      }>(observation.runtime, "GET",
        `/admin/execution/check?task=${encodeURIComponent(opts.task)}&iteration=${opts.iteration}`);
      if (bridgeCheck.workspaceId !== workspace.id || bridgeCheck.taskId !== opts.task || bridgeCheck.iteration !== opts.iteration) {
        throw new Error("BRIDGE_EXECUTION_CHECK_IDENTITY_MISMATCH");
      }
      const binding = readExecutionStoreBinding(workspace.id);
      const selectedStoreFingerprint = binding?.stateStoreFingerprint ?? configuredStateDirFingerprint;
      result.bridgeExecutionStoreFingerprint = bridgeCheck.stateStoreFingerprint;
      result.selectedExecutionStoreFingerprint = selectedStoreFingerprint;
      result.configuredStateDirDiffers = configuredStateDirFingerprint !== bridgeCheck.stateStoreFingerprint;
      result.bridgeRecordExists = bridgeCheck.exists;
      result.storeBinding = binding ? "bridge" : "local";
      if (selectedStoreFingerprint !== bridgeCheck.stateStoreFingerprint) {
        throw new Error(`STORE_MISMATCH: selected execution store ${selectedStoreFingerprint} differs from the Bridge execution store ${bridgeCheck.stateStoreFingerprint}.`);
      }
      const localExists = hasExecutionRecord(workspace.id, opts.task, opts.iteration);
      if (!bridgeCheck.exists) {
        if (localExists) throw new Error("STORE_MISMATCH: local record exists but the Bridge execution store does not contain it.");
        throw new Error("BRIDGE_EXECUTION_RECORD_MISSING: the active Bridge has no exact task and iteration record.");
      }
      if (!binding && !localExists) {
        throw new Error("STORE_MISMATCH: the Bridge reports a record that is absent from the selected local store.");
      }
      result.ok = true;
      if (opts.json) say(JSON.stringify(result));
      else check(`已通过 Bridge 验证 execution record：${opts.task} / iteration ${opts.iteration}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.error = message;
      if (opts.json) say(JSON.stringify(result));
      else cross(message);
      process.exitCode = 1;
    }
  });

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(
  tunnelCmd
    .command("login")
    .description("Open the Cloudflare login window used by a named hostname")
    .option("--json", "machine-readable output", false)
)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
