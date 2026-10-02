import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSession, sessionFile, writeSession, type SavedSession } from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const projectRoute = "g-p-6ab0cb548aec8191a2f43dffeceb9bc0-sfgcdnhb";
const projectUrl = `https://chatgpt.com/g/${projectRoute}/project`;
const chatUrl = `https://chatgpt.com/g/${projectRoute}/c/adopted-chat`;

function runSession(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, "session", ...args, "-w", root], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function withSessionEnvironment(run: (root: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("session-cli-workspace");
  const stateDir = makeTmpDir("session-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  try {
    run(root, new Workspace(root));
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

function savePrevious(workspace: Workspace, overrides: Partial<SavedSession> = {}): SavedSession {
  return writeSession(workspace.id, {
    conversationMode: "project",
    projectUrl,
    connectorName: "Codex with ChatGPT · Demo",
    url: `https://chatgpt.com/g/${projectRoute}/c/old-chat`,
    title: "Old title",
    taskId: "c2c_old",
    iteration: 4,
    lastState: "EXECUTED",
    checkpoint: {
      taskId: "c2c_old",
      iteration: 4,
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    savedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("c2c session adopt", () => {
  it("persists a normalized chat and returns JSON with default Project reuse disabled", () => {
    withSessionEnvironment((root, workspace) => {
      const previous = savePrevious(workspace);
      const result = runSession(root, ["adopt", "--url", `${chatUrl.replace("chatgpt.com", "www.chatgpt.com")}/?q=1#context`, "--json"]);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        session: { conversationMode: "project", projectUrl, connectorName: previous.connectorName, url: chatUrl },
        conversation: { mode: "project", projectReady: true, reuseSavedChat: false },
      });
      expect(readSession(workspace.id)).toEqual(payload.session);
      for (const field of ["taskId", "iteration", "lastState", "checkpoint", "title"]) {
        expect(payload.session).not.toHaveProperty(field);
      }
      expect(payload.session.savedAt).not.toBe(previous.savedAt);
      const later = runSession(root, ["--json"]);
      expect(later.status).toBe(0);
      expect(JSON.parse(later.stdout).conversation.reuseSavedChat).toBe(false);
    });
  });

  it("reports adoption in human-readable output", () => {
    withSessionEnvironment((root, workspace) => {
      savePrevious(workspace);
      const result = runSession(root, ["adopt", "--url", chatUrl]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("已接管");
      expect(readSession(workspace.id)?.url).toBe(chatUrl);
    });
  });

  it.each([
    { url: "https://chatgpt.com/g/other-project/c/chat", overrides: {}, error: /bound Project/ },
    { url: "https://chatgpt.com/c/chat", overrides: {}, error: /Project chat URL/ },
    { url: projectUrl, overrides: {}, error: /Project chat URL/ },
    { url: chatUrl, overrides: { conversationMode: "long-chat" as const }, error: /project mode/ },
    { url: chatUrl, overrides: { projectUrl: undefined }, error: /Bind Project/ },
    { url: chatUrl, overrides: { projectUrl: "https://chatgpt.com/c/chat" }, error: /Bind Project/ },
  ])("rejects $url / $overrides without changing the session file", ({ url, overrides, error }) => {
    withSessionEnvironment((root, workspace) => {
      savePrevious(workspace, overrides);
      const before = fs.readFileSync(sessionFile(workspace.id), "utf8");
      const result = runSession(root, ["adopt", "--url", url, "--json"]);
      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(error);
      expect(fs.readFileSync(sessionFile(workspace.id), "utf8")).toBe(before);
    });
  });

  it("does not create a Project binding when the session is missing", () => {
    withSessionEnvironment((root, workspace) => {
      const result = runSession(root, ["adopt", "--url", chatUrl, "--json"]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/Bind Project/) });
      expect(fs.existsSync(sessionFile(workspace.id))).toBe(false);
    });
  });

  it("preserves the existing Bind Project and clear behavior", () => {
    withSessionEnvironment((root, workspace) => {
      const bound = runSession(root, ["set", "--mode", "project", "--project-url", projectUrl, "--connector-name", "Demo"]);
      expect(bound.status).toBe(0);
      expect(readSession(workspace.id)).toMatchObject({ conversationMode: "project", projectUrl, connectorName: "Demo" });
      expect(runSession(root, ["adopt", "--url", chatUrl]).status).toBe(0);
      expect(runSession(root, ["clear"]).status).toBe(0);
      const cleared = readSession(workspace.id);
      expect(cleared).toMatchObject({ conversationMode: "project", projectUrl, connectorName: "Demo" });
      expect(cleared?.url).toBeUndefined();
    });
  });
});
