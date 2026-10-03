import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeBridgeProcesses, describeCloudflaredProcesses, inspectLocalCloudflared } from "../src/process/diagnostics.js";
import type { ProcessRecord, ProcessSnapshot } from "../src/process/inspect.js";
import { makeTmpDir, cleanup } from "./helpers.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(checkout, "dist", "cli", "index.js");

it("reports local same-tunnel cloudflared ownership without treating an unrelated workspace as owned", () => {
  const workspace = makeTmpDir("cloudflared-diagnostics-workspace");
  const other = makeTmpDir("cloudflared-diagnostics-other");
  const tunnelId = "11111111-1111-4111-8111-111111111111";
  const bridge = (pid: number, root: string, port: number): ProcessRecord => ({ pid, parentPid: 1,
    executable: process.execPath, argv: [process.execPath, entry, "serve", "--workspace", root],
    startId: `linux:${pid}`, cwd: checkout });
  const processes: ProcessRecord[] = [bridge(100, workspace, 48765), bridge(200, other, 12780),
    { pid: 101, parentPid: 100, executable: "C:\\Cloudflare\\cloudflared.exe",
      argv: ["cloudflared.exe", "tunnel", "--url", "http://127.0.0.1:48765", "run", tunnelId], startId: "linux:101", cwd: checkout },
    { pid: 201, parentPid: 200, executable: "C:\\Cloudflare\\cloudflared.exe",
      argv: ["cloudflared.exe", "tunnel", "--url", "http://127.0.0.1:12780", "run", tunnelId], startId: "linux:201", cwd: checkout },
    { pid: 300, parentPid: 1, executable: "C:\\Cloudflare\\cloudflared.exe",
      argv: ["cloudflared.exe", "tunnel", "--url", "http://127.0.0.1:60000", "run", tunnelId], startId: "linux:300", cwd: checkout },
  ];
  const snapshot: ProcessSnapshot = { processes, listeners: [100], listenerOwners: [{ pid: 100, port: 48765 }, { pid: 200, port: 12780 }] };
  try {
    const bridges = [
      { record: processes[0]!, workspaceRoot: workspace, port: 48765, instanceId: "one" },
      { record: processes[1]!, workspaceRoot: other, port: 12780, instanceId: "two" },
    ];
    expect(describeBridgeProcesses(bridges).detail).toBe("DUPLICATE_BRIDGE: verified PIDs 100, 200");
    const diagnostics = inspectLocalCloudflared(snapshot, tunnelId, workspace, bridges);
    expect(diagnostics).toEqual({ totalForTunnel: 3, ownedByWorkspace: 1, otherWorkspace: 1, orphanedOrMismatched: 1,
      pids: [101, 201, 300], orphanedPids: [300] });
    expect(describeCloudflaredProcesses(diagnostics)).toEqual({ ok: false,
      detail: "DUPLICATE_CLOUDFLARED: 3 local processes for the configured Tunnel UUID" });
    const parentMismatch = inspectLocalCloudflared({ ...snapshot, processes: [processes[0]!, processes[4]!], listeners: [], listenerOwners: [] }, tunnelId, workspace, [bridges[0]!]);
    expect(describeCloudflaredProcesses(parentMismatch).detail).toBe("CLOUDFLARED_PARENT_MISMATCH: owned=0, otherWorkspace=0, orphaned=1");
  } finally { cleanup(workspace); cleanup(other); }
});
