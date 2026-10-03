import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { canonicalPathFingerprint } from "../src/config/paths.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let stateDir: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = jsonOf<T>(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  fs.writeFileSync(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists all ten read-only tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "execution_output",
      "execution_summary",
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "read_image",
      "search_workspace",
      "test_status",
      "workspace_info",
    ]);
    // no write tools in V1
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "bridgeInstanceId", "executionStoreFingerprint", "projectType", "git"]);
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "hasMore"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "startLine", "endLine", "nextStartLine"]);
    expect(tools.find((tool) => tool.name === "read_image")?.outputSchema).toBeUndefined();
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "branch", "staged", "unstaged", "untracked", "hidden"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "test_status", ["available", "bridgeInstanceId", "executionStoreFingerprint", "tests", "outputAvailable", "outputId"]);
    expectToolOutputSchema(tools, "execution_summary", ["bridgeInstanceId", "executionStoreFingerprint", "records"]);
    expectToolOutputSchema(tools, "execution_output", ["action", "items", "text"]);
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string };
      bridgeInstanceId: string; executionStoreFingerprint: string }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.bridgeInstanceId).toBe(bridge.instanceId);
    expect(info.executionStoreFingerprint).toBe(canonicalPathFingerprint(stateDir));
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_image returns metadata and image content", async () => {
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "read_image", arguments: { path: "pixel.png" } });
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const metadataText = content.find((item) => item.type === "text")?.text;

    expect(tools.find((tool) => tool.name === "read_image")?.outputSchema).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(metadataText).toBe(JSON.stringify({ path: "pixel.png", sizeBytes: 11, mimeType: "image/png" }, null, 2));
    expect(content.some((item) => item.type === "image" && item.mimeType === "image/png" && item.data)).toBe(true);
  });

  it("read_image keeps workspace containment, sensitive-path and signature checks", async () => {
    write(root, "spoofed.png", "not an image");
    write(root, "unsafe.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const imagePath of [".env", "../outside.png", "spoofed.png", "unsafe.svg"]) {
      const result = await client.callTool({ name: "read_image", arguments: { path: imagePath } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain("supersecret");
      expect((result.content as { type: string }[]).some((item) => item.type === "image")).toBe(false);
    }
  });

  it("read_image rejects images beyond the size limit", async () => {
    const largeImage = path.join(root, "oversized.png");
    const fd = fs.openSync(largeImage, "w");
    try { fs.ftruncateSync(fd, 10 * 1024 * 1024 + 1); }
    finally { fs.closeSync(fd); }
    const result = await client.callTool({ name: "read_image", arguments: { path: "oversized.png" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("FILE_TOO_LARGE");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const summary = structuredJsonOf<{ bridgeInstanceId: string; executionStoreFingerprint: string; records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");
    expect(summary.bridgeInstanceId).toBe(bridge.instanceId);
    expect(summary.executionStoreFingerprint).toBe(canonicalPathFingerprint(stateDir));

    const status = structuredJsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null;
      bridgeInstanceId: string; executionStoreFingerprint: string }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
    expect(status.bridgeInstanceId).toBe(bridge.instanceId);
    expect(status.executionStoreFingerprint).toBe(canonicalPathFingerprint(stateDir));
  });

  it("returns an optional executor through both execution MCP tools", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_executor", iteration: 2, changedFiles: 0, tests: "passed",
      exitStatus: "ok", timestamp: new Date().toISOString(), executor: "antigravity",
    });
    const status = structuredJsonOf<{ executor: string }>(await client.callTool({ name: "test_status", arguments: {} }));
    expect(status.executor).toBe("antigravity");
    const summary = structuredJsonOf<{ records: { executor?: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records).toEqual(expect.arrayContaining([expect.objectContaining({ executor: "antigravity" })]));
    expect(summary.records.some((record) => record.executor === undefined)).toBe(true);
  });

  it("read_image requires workspace.read scope", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "image-scope", scopes: ["git.read"] });
    const limitedClient = new Client({ name: "image-scope", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    try {
      await limitedClient.connect(transport);
      const result = await limitedClient.callTool({ name: "read_image", arguments: { path: "pixel.png" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INSUFFICIENT_SCOPE");
      expect((result.content as { type: string }[]).some((item) => item.type === "image")).toBe(false);
    } finally { await limitedClient.close(); }
  });

  it("skips invalid persisted records when reporting execution status", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_valid_before_invalid",
      iteration: 2,
      changedFiles: 0,
      tests: "31 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(
      path.join(stateDir, "executions", `${bridge.workspace.id}.jsonl`),
      JSON.stringify({
        taskId: "c2c_invalid",
        iteration: null,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );

    const statusResult = await client.callTool({ name: "test_status", arguments: {} });
    expect(statusResult.isError ?? false).toBe(false);
    const status = structuredJsonOf<{ taskId: string; iteration: number }>(statusResult);
    expect(status.taskId).toBe("c2c_valid_before_invalid");
    expect(status.iteration).toBe(2);

    const summaryResult = await client.callTool({ name: "execution_summary", arguments: { limit: 1 } });
    expect(summaryResult.isError ?? false).toBe(false);
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(summaryResult);
    expect(summary.records.map((record) => record.taskId)).toEqual(["c2c_valid_before_invalid"]);
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const listResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    const list = structuredJsonOf<{
      action: "list";
      items: { id: number; status: string; command: string; text?: string }[];
    }>(listResult);
    expect(list.action).toBe("list");
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const readResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: readable.id },
    });
    const body = structuredJsonOf<{ action: "read"; text: string }>(readResult);
    expect(body.action).toBe("read");
    expect(body.text).toContain("AssertionError");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});

describe("aggregate workspace with nested Git repository over MCP", () => {
  let aggRoot: string;
  let nestedRepoDir: string;
  let outsideDir: string;
  let aggBridge: Bridge;
  let aggClient: Client;
  let symlinksReady = true;

  beforeAll(async () => {
    aggRoot = makeTmpDir("mcp-aggregate-ws");
    // Stop Git from discovering the parent codex-with-chatgpt repository:
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(aggRoot);

    // Create nested git repo
    nestedRepoDir = path.join(aggRoot, "nested-repo");
    fs.mkdirSync(nestedRepoDir, { recursive: true });
    makeGitRepo(nestedRepoDir);

    // Create an uncommitted change in nested-repo
    write(nestedRepoDir, "src/index.ts", "export const nestedValue = 99;\n");
    write(nestedRepoDir, "nested-safe.txt", "safe nested file\n");
    write(nestedRepoDir, "..internal/file.ts", "export const internalValue = 1;\n");
    git(nestedRepoDir, "add", "..internal/file.ts");
    git(nestedRepoDir, "commit", "-m", "add internal file");
    write(nestedRepoDir, "..internal/file.ts", "export const internalValue = 2; // safe-in-repo\n");

    // Create an other directory in aggregate workspace (not in nested-repo)
    write(aggRoot, "other-dir/outside-file.txt", "outside file content\n");

    // Symlink escape test setup
    outsideDir = makeTmpDir("mcp-agg-outside");
    write(outsideDir, "secret.txt", "secret outside\n");
    try {
      fs.symlinkSync(outsideDir, path.join(aggRoot, "symlink-out"));
    } catch {
      symlinksReady = false;
    }

    aggBridge = await startBridge({
      workspaceRoot: aggRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-agg"), "store.json"),
    });
    const tokens = aggBridge.authStore.issueTokens({
      clientId: "agg-client",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    });

    aggClient = new Client({ name: "c2c-agg-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${aggBridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    });
    await aggClient.connect(transport);
  });

  afterAll(async () => {
    await aggClient.close();
    await aggBridge.close();
    cleanup(aggRoot);
    cleanup(outsideDir);
    delete process.env.GIT_CEILING_DIRECTORIES;
  });

  it("git_status({}) reports isRepo: false for aggregate workspace root", async () => {
    const result = await aggClient.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean }>(result);
    expect(status.isRepo).toBe(false);
  });

  it("git_status({ repo_path: 'nested-repo' }) reports isRepo: true and nested repo changes", async () => {
    const result = await aggClient.callTool({
      name: "git_status",
      arguments: { repo_path: "nested-repo" },
    });
    const status = structuredJsonOf<{
      isRepo: boolean;
      branch: string;
      unstaged: { path: string }[];
      untracked: string[];
    }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
    expect(status.untracked).toContain("nested-safe.txt");
  });

  it("git_diff({ repo_path: 'nested-repo', mode: 'unstaged' }) returns nested repo diff", async () => {
    const result = await aggClient.callTool({
      name: "git_diff",
      arguments: { repo_path: "nested-repo", mode: "unstaged" },
    });
    const diff = structuredJsonOf<{ isRepo: boolean; diff: string }>(result);
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("nestedValue = 99");
  });

  it("rejects repo_path escaping workspace with PATH_OUTSIDE_WORKSPACE", async () => {
    const result = await aggClient.callTool({
      name: "git_status",
      arguments: { repo_path: "../outside" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects repo_path via symlink escaping workspace", async () => {
    if (!symlinksReady) return;
    const result = await aggClient.callTool({
      name: "git_status",
      arguments: { repo_path: "symlink-out" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("supports git_diff.path scoping within selected repo and rejects path outside selected repo", async () => {
    // 1. Path within selected repo
    const inScope = await aggClient.callTool({
      name: "git_diff",
      arguments: {
        repo_path: "nested-repo",
        path: "nested-repo/src",
        mode: "unstaged",
      },
    });
    expect(inScope.isError ?? false).toBe(false);
    const inScopeDiff = structuredJsonOf<{ isRepo: boolean; diff: string }>(inScope);
    expect(inScopeDiff.isRepo).toBe(true);
    expect(inScopeDiff.diff).toContain("nestedValue = 99");

    // 2. Repo-internal path whose segment name begins with '..' (e.g. '..internal')
    const dotDotScope = await aggClient.callTool({
      name: "git_diff",
      arguments: {
        repo_path: "nested-repo",
        path: "nested-repo/..internal",
        mode: "unstaged",
      },
    });
    expect(dotDotScope.isError ?? false).toBe(false);
    const dotDotDiff = structuredJsonOf<{ isRepo: boolean; diff: string }>(dotDotScope);
    expect(dotDotDiff.isRepo).toBe(true);
    expect(dotDotDiff.diff).toContain("safe-in-repo");

    // 3. Path outside selected repo but within workspace
    const outOfScope = await aggClient.callTool({
      name: "git_diff",
      arguments: {
        repo_path: "nested-repo",
        path: "other-dir/outside-file.txt",
        mode: "unstaged",
      },
    });
    expect(outOfScope.isError).toBe(true);
    expect(textOf(outOfScope)).toContain("INVALID_PATH");
  });
});
