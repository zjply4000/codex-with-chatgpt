import { describe, expect, it, vi } from "vitest";
import { createProcessInspector, type ProcessInspectorOptions } from "../src/process/inspect.js";

const denied = () => Object.assign(new Error("secret credential"), { code: "EACCES" });
const gone = () => Object.assign(new Error("gone"), { code: "ENOENT" });
const stat = (birth = "987") => `42 (node (worker)) S 1 ${Array(17).fill("0").join(" ")} ${birth} 0`;
function linux(overrides: Partial<ProcessInspectorOptions> = {}) {
  return createProcessInspector({
    platform: "linux",
    readdir: async (p) => p === "/proc" ? ["42", "43", "net"] : ["7"],
    readFile: async (p) => {
      if (p.endsWith("/stat")) { if (p.includes("/43/")) throw denied(); return Buffer.from(stat()); }
      if (p.endsWith("/cmdline")) return Buffer.from("/usr/bin/node\0/project path/cli.js\0serve\0--workspace\0/project path\0\0");
      if (p.endsWith("/tcp")) return Buffer.from("  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n  0: 0100007F:2253 00000000:0000 0A 0:0 00:0 0 1000 0 999\n");
      if (p.endsWith("/tcp6")) return Buffer.from("  sl local_address rem_address st\n");
      throw gone();
    },
    readlink: async (p) => p.endsWith("/exe") ? "/usr/bin/node" : p.endsWith("/cwd") ? "/project path" : "socket:[999]",
    signal: vi.fn(),
    ...overrides,
  });
}
const winRow = (creation = "2026-10-02T00:00:00.1234567Z", commandLine: string | null = '"C:\\Program Files\\node.exe" "D:\\project path\\cli.js" serve --workspace "D:\\project path" ""') => ({
  ProcessId: 42, ParentProcessId: 1, ExecutablePath: "C:\\Program Files\\node.exe", CommandLine: commandLine, CreationDate: creation,
});
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const macArgs = () => {
  const header = Buffer.alloc(4); header.writeInt32LE(5);
  return Buffer.concat([header, Buffer.from("/usr/bin/node\0\0\0node\0/project path/cli.js\0serve\0--workspace\0/project path\0TOKEN=secret\0")]);
};

describe("OS process inspection", () => {
  it("reads Linux argv by NUL boundaries and preserves denied candidates", async () => {
    const snapshot = await linux().snapshot(8787);
    expect(snapshot.processes).toEqual([
      { pid: 42, parentPid: 1, executable: "/usr/bin/node", argv: ["/usr/bin/node", "/project path/cli.js", "serve", "--workspace", "/project path", ""], startId: "linux:987", cwd: "/project path" },
      { pid: 43, parentPid: -1, executable: null, argv: null, startId: null, cwd: null },
    ]);
    expect(snapshot.listeners).toEqual([42, 43]);
  });

  it("blocks missing listener ownership and failed enumeration without exposing errors", async () => {
    await expect(linux({ readlink: async () => { throw denied(); } }).snapshot(8787)).rejects.toThrow(/inspect|listener/i);
    await expect(linux({ readdir: async () => { throw denied(); } }).snapshot(8787)).rejects.not.toThrow(/secret/);
  });

  it("decodes Windows quoting, escaping, empty arguments and uses only fixed script arguments", async () => {
    const calls: Array<[string, string[]]> = [];
    const inspector = createProcessInspector({ platform: "win32", runner: async (command, args) => {
      calls.push([command, args]);
      return args.includes("-EncodedCommand") ? json([winRow()]) : Buffer.from("\n TCP 127.0.0.1:8787 0.0.0.0:0 LISTENING 42\n TCP [::1]:8787 [::]:0 LISTENING 42\n");
    } });
    const snapshot = await inspector.snapshot(8787);
    expect(snapshot.processes[0]).toMatchObject({ argv: ["C:\\Program Files\\node.exe", "D:\\project path\\cli.js", "serve", "--workspace", "D:\\project path", ""], startId: "windows:2026-10-02T00:00:00.1234567Z", cwd: null });
    expect(snapshot.listeners).toEqual([42]);
    expect(calls[0][1]).toContain("-EncodedCommand");
    expect(calls[1]).toEqual(["netstat.exe", ["-ano", "-p", "tcp"]]);
  });

  it("retains Windows processes lacking commandlines and refuses malformed introspection", async () => {
    const inspector = createProcessInspector({ platform: "win32", runner: async (_cmd, args) => args.includes("-EncodedCommand") ? json([winRow(undefined, null)]) : Buffer.alloc(0) });
    expect((await inspector.snapshot(8787)).processes[0].argv).toBeNull();
    await expect(createProcessInspector({ platform: "win32", runner: async () => Buffer.from("secret malformed") }).snapshot(8787)).rejects.not.toThrow(/secret/);
  });

  it("suppresses Windows CIM import progress without weakening error handling", async () => {
    const inspector = createProcessInspector({ platform: "win32", runner: async (_command, args) => {
      const encodedIndex = args.indexOf("-EncodedCommand");
      if (encodedIndex < 0) return Buffer.alloc(0);
      const script = Buffer.from(args[encodedIndex + 1], "base64").toString("utf16le");
      const beforeImport = script.split("Get-CimInstance")[0];
      // Model Windows PowerShell's module-import progress written as CLIXML
      // on stderr even though the CIM query itself succeeds.
      if (!/\$ProgressPreference\s*=\s*['"]SilentlyContinue['"]/.test(beforeImport)) throw new Error("#< CLIXML import progress");
      expect(beforeImport).toMatch(/\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
      return json([winRow()]);
    } });
    expect((await inspector.snapshot(8787)).processes[0].pid).toBe(42);
  });

  it("preserves Windows escaped quotes and backslashes before argument separators", async () => {
    const row = winRow(undefined, String.raw`node.exe plain\ next "quoted\"value" "trailing\\"`);
    const inspector = createProcessInspector({ platform: "win32", runner: async (_cmd, args) => args.includes("-EncodedCommand") ? json([row]) : Buffer.alloc(0) });
    expect((await inspector.snapshot(8787)).processes[0].argv).toEqual(["node.exe", "plain\\", "next", 'quoted"value', "trailing\\"]);
  });

  it("rejects malformed listener output instead of reporting an empty port", async () => {
    const inspector = createProcessInspector({ platform: "win32", runner: async (_cmd, args) => args.includes("-EncodedCommand") ? json([winRow()]) : Buffer.from("secret invalid diagnostics") });
    await expect(inspector.snapshot(8787)).rejects.toThrow(/inspection/i);
  });

  it("reads macOS native binary argv using argc without exposing environment", async () => {
    const calls: Array<[string, string[]]> = [];
    const inspector = createProcessInspector({ platform: "darwin", runner: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("python3")) return json([{ pid: 42, parentPid: 1, executable: "/usr/bin/node", startId: "darwin:123:456", cwd: "/project path", procArgsBase64: macArgs().toString("base64") }]);
      return Buffer.from("p42\n");
    } });
    expect((await inspector.snapshot(8787)).processes[0].argv).toEqual(["node", "/project path/cli.js", "serve", "--workspace", "/project path"]);
    expect(calls[0][1][0]).toBe("-c");
    expect(calls[0][1][1]).toContain("sysctl");
    expect(calls[1][1]).toContain("-iTCP:8787");
  });

  it("never guesses macOS argv from a truncated native buffer", async () => {
    const inspector = createProcessInspector({ platform: "darwin", runner: async (command) => command.endsWith("python3") ? json([{ pid: 42, parentPid: 1, executable: "/usr/bin/node", startId: "darwin:123:456", cwd: null, procArgsBase64: Buffer.from("node cli.js serve").toString("base64") }]) : Buffer.alloc(0) });
    expect((await inspector.snapshot(8787)).processes[0].argv).toBeNull();
  });

  it("rechecks birth, executable and argv before POSIX SIGTERM", async () => {
    const signal = vi.fn();
    let birth = "987";
    const inspector = linux({ signal, readFile: async (p) => p.endsWith("/stat") ? Buffer.from(stat(birth)) : p.endsWith("/cmdline") ? Buffer.from("node\0cli.js\0") : Buffer.from("sl local_address rem_address st\n") });
    const record = (await inspector.snapshot(8787)).processes[0];
    birth = "988";
    await expect(inspector.terminate(record)).rejects.toThrow(/identity|changed/i);
    expect(signal).not.toHaveBeenCalled();
    birth = "987";
    await inspector.terminate(record);
    expect(signal).toHaveBeenCalledWith(42, "SIGTERM");
  });

  it("uses a single Windows validated PID and refuses inaccessible identities", async () => {
    const calls: Array<[string, string[]]> = [];
    const inspector = createProcessInspector({ platform: "win32", runner: async (command, args) => { calls.push([command, args]); return command === "taskkill.exe" ? Buffer.alloc(0) : args.includes("-EncodedCommand") ? json([winRow()]) : Buffer.alloc(0); } });
    const record = (await inspector.snapshot(8787)).processes[0];
    await inspector.terminate(record);
    expect(calls.at(-1)).toEqual(["taskkill.exe", ["/PID", "42", "/F"]]);
    await expect(inspector.terminate({ ...record, argv: null })).rejects.toThrow(/identity|verify/i);
  });

  it.each(["argv", "executable", "birth", "parent"])("refuses Windows %s changes immediately before termination", async (changed) => {
    let changedNow = false;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (!args.includes("-EncodedCommand")) return Buffer.alloc(0);
      const row = winRow();
      if (changedNow && changed === "argv") row.CommandLine = "node other.js";
      if (changedNow && changed === "executable") row.ExecutablePath = "D:\\other.exe";
      if (changedNow && changed === "birth") row.CreationDate = "2026-10-02T00:00:01.1234567Z";
      if (changedNow && changed === "parent") row.ParentProcessId = 88;
      return json([row]);
    });
    const inspector = createProcessInspector({ platform: "win32", runner });
    const record = (await inspector.snapshot(8787)).processes[0];
    changedNow = true;
    await expect(inspector.terminate(record)).rejects.toThrow(/identity/i);
    expect(runner.mock.calls.some(([command]) => command === "taskkill.exe")).toBe(false);
  });

  it("treats an independently confirmed disappeared PID as no-op", async () => {
    const signal = vi.fn();
    const inspector = linux({ signal });
    const record = (await inspector.snapshot(8787)).processes[0];
    const absent = linux({ signal, readFile: async () => { throw gone(); } });
    await absent.terminate(record);
    expect(signal).not.toHaveBeenCalled();
  });

  it("keeps the PID proof immutable while process inspection is in flight", async () => {
    let mutate: (() => void) | undefined;
    const killed: string[][] = [];
    const inspector = createProcessInspector({ platform: "win32", runner: async (command, args) => {
      if (command === "taskkill.exe") { killed.push(args); return Buffer.alloc(0); }
      if (!args.includes("-EncodedCommand")) return Buffer.alloc(0);
      mutate?.();
      return json([winRow()]);
    } });
    const record = (await inspector.snapshot(8787)).processes[0];
    mutate = () => { record.pid = 99; };
    await inspector.terminate(record);
    expect(killed).toEqual([["/PID", "42", "/F"]]);
  });

  it("refuses a changed Linux cwd after the process tree was verified", async () => {
    const signal = vi.fn();
    let cwd = "/project path";
    const inspector = linux({ signal, readlink: async (p) => p.endsWith("/exe") ? "/usr/bin/node" : p.endsWith("/cwd") ? cwd : "socket:[999]" });
    const record = (await inspector.snapshot(8787)).processes[0];
    cwd = "/other workspace";
    await expect(inspector.terminate(record)).rejects.toThrow(/identity/i);
    expect(signal).not.toHaveBeenCalled();
  });

  it("rejects unsupported platforms and untrusted port/PID inputs before invoking commands", async () => {
    const runner = vi.fn();
    const inspector = createProcessInspector({ platform: "freebsd", runner });
    await expect(inspector.snapshot(8787)).rejects.toThrow(/support|inspect/i);
    await expect(inspector.snapshot(Number.NaN)).rejects.toThrow();
    await expect(inspector.terminate({ pid: -1, parentPid: 0, executable: "node", argv: ["node"], startId: "one", cwd: null })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});
