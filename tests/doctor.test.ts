import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeRuntimeState, runtimeFile } from "../src/bridge/runtime.js";
import { endpointFile, writeLastEndpoint } from "../src/config/endpoint.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runDoctor(root: string, stateDir: string, codexHome: string, noFix: boolean, json = true) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", cliEntry, "doctor", "-w", root, ...(json ? ["--json"] : []), ...(noFix ? ["--no-fix"] : [])], {
      cwd: projectRoot, encoding: "utf8", windowsHide: true,
      env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome },
    }, (error, stdout, stderr) => resolve({ status: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

describe("doctor runtime identity", () => {
  it("keeps normal doctor behavior for an authenticated matching instance", async () => {
    const root = makeTmpDir("doctor-live-ws");
    const stateDir = makeTmpDir("doctor-live-state");
    const codexHome = makeTmpDir("doctor-live-codex");
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    const workspace = new Workspace(root);
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok", instanceId: "current-instance" }));
      } else if (req.url === "/admin/info" && req.headers.authorization === "Bearer current-token") {
        res.end(JSON.stringify({ workspaceId: workspace.id, workspaceName: workspace.name,
          publicUrl: null, tunnel: { running: false, url: null, provider: "none" } }));
      } else {
        res.writeHead(req.url === "/mcp" ? 401 : 404).end("{}");
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      writeRuntimeState({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceRoot: root,
        pid: process.pid, port: address.port, instanceId: "current-instance", adminToken: "current-token",
        publicUrl: null, startedAt: "2026-01-01T00:00:00.000Z" });
      const result = await runDoctor(root, stateDir, codexHome, false);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.report.bridge).toMatchObject({ ok: true, state: "healthy" });
      expect(payload.report.mcp.ok).toBe(true);
      expect(payload.report.tunnel.ok).toBe(true);
      expect(payload.bridgeRepair.needed).toBe(false);
      expect(payload.chatgptRepair.needed).toBe(false);
      expect(payload.repairs).not.toContain("已自动启动 Bridge");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
      cleanup(root); cleanup(stateDir); cleanup(codexHome);
    }
  });

  it.each([
    { runtimeInstance: "old-instance", healthInstance: "live-instance", noFix: true },
    { runtimeInstance: "old-instance", healthInstance: "live-instance", noFix: false },
    { runtimeInstance: undefined, healthInstance: undefined, noFix: true },
    { runtimeInstance: "live-instance", healthInstance: "live-instance", noFix: true },
  ])("reports stale runtime or lost admin capability without repairing the connector: %j", async ({ runtimeInstance, healthInstance, noFix }) => {
    const root = makeTmpDir("doctor-ws");
    const stateDir = makeTmpDir("doctor-state");
    const codexHome = makeTmpDir("doctor-codex");
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    const workspace = new Workspace(root);
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok", instanceId: healthInstance }));
      } else if (req.url === "/mcp") {
        res.writeHead(401).end("{}");
      } else {
        res.writeHead(404).end("{}");
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      writeRuntimeState({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceRoot: root,
        pid: process.pid, port: address.port, instanceId: runtimeInstance, adminToken: "stale-token",
        publicUrl: null, startedAt: "2026-01-01T00:00:00.000Z" });
      writeLastEndpoint({ workspaceId: workspace.id, port: address.port, publicUrl: "https://live.example.invalid",
        mcpUrl: "https://live.example.invalid/mcp", connectorName: "Codex with ChatGPT · Demo" });
      const runtimeBefore = fs.readFileSync(runtimeFile(workspace.id), "utf8");
      const endpointBefore = fs.readFileSync(endpointFile(workspace.id), "utf8");

      const result = await runDoctor(root, stateDir, codexHome, noFix);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stdout).not.toContain("Admin request failed");
      const payload = JSON.parse(result.stdout);
      const expectedReason = runtimeInstance && runtimeInstance === healthInstance ? "admin_unavailable" : "stale_runtime";
      expect(payload.report.bridge).toMatchObject({ ok: false, state: "unknown", reason: expectedReason });
      expect(payload.bridgeRepair).toMatchObject({ needed: true, reason: expectedReason, automatic: false, userMessage: expect.any(String) });
      expect(payload.chatgptRepair).toMatchObject({ needed: false, connectorAction: "none" });
      expect(payload.namedRepair.needed).toBe(false);
      expect(payload.repairs).not.toContain("已自动启动 Bridge");
      expect(result.stdout).not.toContain("stale-token");
      expect(requests.filter((request) => request.includes("/admin/"))).toEqual(expectedReason === "stale_runtime" ? [] : ["GET /admin/info"]);
      expect(requests.some((request) => request.includes("/admin/tunnel") || request.includes("/admin/pairing"))).toBe(false);
      expect(fs.readFileSync(runtimeFile(workspace.id), "utf8")).toBe(runtimeBefore);
      expect(fs.readFileSync(endpointFile(workspace.id), "utf8")).toBe(endpointBefore);
      expect(fs.existsSync(path.join(stateDir, "logs"))).toBe(false);
      if (runtimeInstance === "old-instance" && noFix) {
        const human = await runDoctor(root, stateDir, codexHome, true, false);
        expect(human.status).toBe(1);
        expect(human.stdout).toContain("c2c bridge recover");
        expect(human.stdout).toContain("c2c bridge recover --dry-run");
        expect(human.stdout).not.toContain("c2c bridge recover -w");
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
      cleanup(root); cleanup(stateDir); cleanup(codexHome);
    }
  });
});
