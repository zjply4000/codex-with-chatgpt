import { execFile } from "node:child_process";
import fs from "node:fs/promises";

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  executable: string | null;
  argv: string[] | null;
  startId: string | null;
  cwd: string | null;
}
export interface ProcessPortListener { port: number; pid: number; }
export interface ProcessSnapshot { processes: ProcessRecord[]; listeners: number[]; listenerOwners?: ProcessPortListener[]; }
export interface ProcessInspector {
  snapshot(port: number): Promise<ProcessSnapshot>;
  terminate(record: ProcessRecord): Promise<void>;
}
export interface ProcessInspectorOptions {
  platform?: string;
  runner?: (command: string, args: string[]) => Promise<Buffer>;
  readFile?: (path: string) => Promise<Buffer>;
  readlink?: (path: string) => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
  signal?: (pid: number, signal: "SIGTERM") => void;
}

const inspectionError = () => new Error("Process inspection unavailable; refusing unverified process management.");
const identityError = () => new Error("Process identity changed or cannot be verified; refusing termination.");
const pidValid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 0;
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const missing = (error: unknown) => code(error) === "ENOENT" || code(error) === "ESRCH";
const blank = (pid: number): ProcessRecord => ({ pid, parentPid: -1, executable: null, argv: null, startId: null, cwd: null });
const unique = (pids: number[]) => [...new Set(pids)].sort((a, b) => a - b);

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      // lsof documents status 1 when its selection matches no files.
      if (error && !(command.endsWith("lsof") && error.code === 1 && !stdout.length && !stderr.length)) return reject(inspectionError());
      if (stderr.length) return reject(inspectionError());
      resolve(stdout);
    });
  });
}

const windowsScript = String.raw`
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId;
    ExecutablePath=$_.ExecutablePath; CommandLine=$_.CommandLine;
    CreationDate=$(if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
`;

/** Decode the documented CRT backslash/quote rules, never split a ps display string. */
function windowsArgv(line: string): string[] | null {
  const result: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length) break;
    let argument = "", quoted = false;
    while (i < line.length) {
      if (!quoted && (line[i] === " " || line[i] === "\t")) break;
      let slashes = 0;
      while (line[i] === "\\") { slashes++; i++; }
      if (line[i] === '"') {
        argument += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) { argument += '"'; i++; }
        else if (quoted && line[i + 1] === '"') { argument += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else {
        argument += "\\".repeat(slashes);
        if (!quoted && (line[i] === " " || line[i] === "\t")) break;
        if (i < line.length) argument += line[i++];
      }
    }
    if (quoted) return null;
    result.push(argument);
  }
  return result.length ? result : null;
}

function jsonArray(output: Buffer): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(output.toString("utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed) || parsed.some((v) => !v || typeof v !== "object" || Array.isArray(v))) throw inspectionError();
    return parsed as Record<string, unknown>[];
  } catch { throw inspectionError(); }
}
const nullableText = (value: unknown): string | null => typeof value === "string" && value.length ? value : null;

function macArgv(encoded: unknown): string[] | null {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 5) return null;
  const argc = bytes.readInt32LE(0);
  if (argc <= 0 || argc > 100_000) return null;
  const executableEnd = bytes.indexOf(0, 4);
  if (executableEnd < 0) return null;
  let offset = executableEnd + 1;
  while (bytes[offset] === 0) offset++;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) return null;
    const argument = bytes.subarray(offset, end).toString("utf8");
    if (argument.includes("\uFFFD")) return null;
    argv.push(argument);
    offset = end + 1;
  }
  return argv;
}

// Fixed helper only: libproc provides microsecond birth identity and parent PID;
// KERN_PROCARGS2 supplies a native argc/executable/padding/NUL-argv buffer.
// Apple ABI: bsd/sys/proc_info.h and bsd/kern/kern_sysctl.c.
const macScript = String.raw`
import base64, ctypes, json, struct
lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libc = ctypes.CDLL(None, use_errno=True)
lib.proc_listpids.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
libc.sysctl.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
capacity = 4096
while True:
    pids = (ctypes.c_int * capacity)()
    count = lib.proc_listpids(1, 0, pids, ctypes.sizeof(pids))
    if count <= 0: raise RuntimeError('enumeration failed')
    if count < ctypes.sizeof(pids): break
    capacity *= 2
    if capacity > 1048576: raise RuntimeError('enumeration overflow')
def bsd(pid):
    buf = ctypes.create_string_buffer(136)
    if lib.proc_pidinfo(pid, 3, 0, buf, 136) != 136: return None
    raw = buf.raw
    return (struct.unpack_from('=I', raw, 16)[0], struct.unpack_from('=QQ', raw, 120))
rows = []
for pid in sorted(set(pids[:count // 4])):
    if pid <= 0: continue
    row = dict(pid=pid, parentPid=-1, executable=None, startId=None, cwd=None, procArgsBase64=None)
    before = bsd(pid)
    if before is None:
        rows.append(row)
        continue
    row['parentPid'] = before[0]
    row['startId'] = 'darwin:%d:%d' % before[1]
    path = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, path, 4096) > 0:
        try: row['executable'] = path.value.decode('utf-8')
        except UnicodeDecodeError: pass
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) == 0 and 4 < size.value <= 67108864:
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0:
            row['procArgsBase64'] = base64.b64encode(buf.raw[:size.value]).decode('ascii')
    # proc_vnodepathinfo has two vnode_info_path entries; the first is cwd.
    # On the supported 64-bit Darwin ABI, its path begins at byte 152.
    vnode = ctypes.create_string_buffer(2352)
    if lib.proc_pidinfo(pid, 9, 0, vnode, 2352) == 2352:
        try: row['cwd'] = vnode.raw[152:1176].split(b'\0', 1)[0].decode('utf-8') or None
        except UnicodeDecodeError: pass
    if bsd(pid) != before:
        row = dict(pid=pid, parentPid=-1, executable=None, startId=None, cwd=None, procArgsBase64=None)
    rows.append(row)
print(json.dumps(rows))
`;

export function createProcessInspector(options: ProcessInspectorOptions = {}): ProcessInspector {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? run;
  const readFile = options.readFile ?? ((p: string) => fs.readFile(p));
  const readlink = options.readlink ?? ((p: string) => fs.readlink(p));
  const readdir = options.readdir ?? ((p: string) => fs.readdir(p));
  const signal = options.signal ?? ((pid: number, sig: "SIGTERM") => { process.kill(pid, sig); });

  async function linuxRecord(pid: number): Promise<ProcessRecord | null> {
    let before: Buffer;
    try { before = await readFile(`/proc/${pid}/stat`); }
    catch (error) { return missing(error) ? null : blank(pid); }
    const match = /^\d+ \(.*\) \S (\d+) (.*)$/.exec(before.toString("utf8"));
    const tail = match?.[2].split(" ");
    if (!match || !tail || !/^\d+$/.test(tail[17] ?? "")) return blank(pid);
    const record = blank(pid);
    record.parentPid = Number(match[1]);
    record.startId = `linux:${tail[17]}`;
    try {
      const bytes = await readFile(`/proc/${pid}/cmdline`);
      if (bytes.length && bytes.at(-1) === 0) {
        const value = bytes.subarray(0, -1).toString("utf8");
        if (!value.includes("\uFFFD")) record.argv = value.split("\0");
      }
    } catch { /* Keep an inaccessible command line explicit. */ }
    try { record.executable = await readlink(`/proc/${pid}/exe`); } catch { /* inaccessible */ }
    try { record.cwd = await readlink(`/proc/${pid}/cwd`); } catch { /* inaccessible */ }
    try {
      const after = await readFile(`/proc/${pid}/stat`);
      const afterMatch = /^\d+ \(.*\) \S (\d+) (.*)$/.exec(after.toString("utf8"));
      if (!afterMatch || afterMatch[1] !== match[1] || afterMatch[2].split(" ")[17] !== tail[17]) return blank(pid);
    } catch (error) { return missing(error) ? null : blank(pid); }
    return record;
  }

  async function enumerate(): Promise<ProcessRecord[]> {
    if (platform === "linux") {
      const pids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p)).map(Number).filter(pidValid);
      return (await Promise.all(pids.map(linuxRecord))).filter((p): p is ProcessRecord => p !== null).sort((a, b) => a.pid - b.pid);
    }
    if (platform === "win32") {
      const rows = jsonArray(await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")]));
      return rows.map((row) => {
        if (!Number.isSafeInteger(row.ProcessId) || (row.ProcessId as number) < 0 || !Number.isSafeInteger(row.ParentProcessId)) throw inspectionError();
        return { pid: row.ProcessId as number, parentPid: row.ParentProcessId as number, executable: nullableText(row.ExecutablePath), argv: typeof row.CommandLine === "string" ? windowsArgv(row.CommandLine) : null, startId: nullableText(row.CreationDate) ? `windows:${row.CreationDate}` : null, cwd: null };
      }).filter((row) => pidValid(row.pid));
    }
    if (platform === "darwin") {
      return jsonArray(await runner("/usr/bin/python3", ["-c", macScript])).map((row) => {
        if (!pidValid(row.pid) || !Number.isSafeInteger(row.parentPid)) throw inspectionError();
        return { pid: row.pid, parentPid: row.parentPid as number, executable: nullableText(row.executable), argv: macArgv(row.procArgsBase64), startId: nullableText(row.startId), cwd: nullableText(row.cwd) };
      });
    }
    throw inspectionError();
  }

  async function listeners(port: number, processes: ProcessRecord[]): Promise<number[]> {
    if (platform === "win32") {
      const output = (await runner("netstat.exe", ["-ano", "-p", "tcp"])).toString("utf8");
      const pids: number[] = [];
      let rows = 0;
      for (const line of output.split(/\r?\n/)) {
        if (!/^\s*TCP\s/i.test(line)) continue;
        rows++;
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 5 || !/^\d+$/.test(fields[4])) throw inspectionError();
        if (fields[3] === "LISTENING" && fields[1].endsWith(`:${port}`)) {
          const pid = Number(fields[4]);
          if (!pidValid(pid)) throw inspectionError();
          pids.push(pid);
        }
      }
      if (output.trim() && !rows) throw inspectionError();
      return unique(pids);
    }
    if (platform === "darwin") {
      const output = (await runner("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])).toString("utf8");
      return unique(output.split(/\r?\n/).filter(Boolean).map((line) => {
        if (!/^p[1-9]\d*$/.test(line)) throw inspectionError();
        return Number(line.slice(1));
      }));
    }
    const inodes = new Set<string>();
    for (const filename of ["tcp", "tcp6"]) {
      let output: Buffer;
      try { output = await readFile(`/proc/net/${filename}`); }
      catch (error) { if (filename === "tcp6" && missing(error)) continue; throw inspectionError(); }
      const lines = output.toString("utf8").trim().split(/\r?\n/);
      if (!lines[0]?.includes("local_address")) throw inspectionError();
      for (const line of lines.slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) throw inspectionError();
        if (fields[3] === "0A" && Number.parseInt(fields[1].split(":")[1], 16) === port) {
          if (!/^\d+$/.test(fields[9]) || fields[9] === "0") throw inspectionError();
          inodes.add(fields[9]);
        }
      }
    }
    if (!inodes.size) return [];
    const owned = new Set<string>(), owners: number[] = [];
    for (const record of processes) {
      let descriptors: string[];
      try { descriptors = await readdir(`/proc/${record.pid}/fd`); } catch { continue; }
      for (const fd of descriptors.filter((entry) => /^\d+$/.test(entry))) {
        let target: string;
        try { target = await readlink(`/proc/${record.pid}/fd/${fd}`); } catch { continue; }
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && inodes.has(inode)) { owned.add(inode); owners.push(record.pid); }
      }
    }
    if (owned.size !== inodes.size) throw inspectionError();
    return unique(owners);
  }

  async function allListenerOwners(processes: ProcessRecord[]): Promise<ProcessPortListener[]> {
    if (platform === "win32") {
      const output = (await runner("netstat.exe", ["-ano", "-p", "tcp"])).toString("utf8");
      const owners: ProcessPortListener[] = [];
      let rows = 0;
      for (const line of output.split(/\r?\n/)) {
        if (!/^\s*TCP\s/i.test(line)) continue;
        rows++;
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 5 || !/^\d+$/.test(fields[4])) throw inspectionError();
        if (fields[3] !== "LISTENING") continue;
        const portMatch = /:(\d+)$/.exec(fields[1]);
        const pid = Number(fields[4]), port = Number(portMatch?.[1]);
        if (!pidValid(pid) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw inspectionError();
        owners.push({ port, pid });
      }
      if (output.trim() && !rows) throw inspectionError();
      return [...new Map(owners.map((owner) => [`${owner.port}:${owner.pid}`, owner])).values()]
        .sort((a, b) => a.port - b.port || a.pid - b.pid);
    }
    if (platform === "darwin") {
      const output = (await runner("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"])).toString("utf8");
      const owners: ProcessPortListener[] = [];
      let pid: number | null = null;
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        if (line.startsWith("p")) {
          const value = Number(line.slice(1));
          if (!pidValid(value)) throw inspectionError();
          pid = value;
        } else if (line.startsWith("n")) {
          const port = Number(/:(\d+)$/.exec(line.slice(1))?.[1]);
          if (!pid || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw inspectionError();
          owners.push({ port, pid });
        }
      }
      return [...new Map(owners.map((owner) => [`${owner.port}:${owner.pid}`, owner])).values()]
        .sort((a, b) => a.port - b.port || a.pid - b.pid);
    }
    if (platform !== "linux") throw inspectionError();

    const inodePorts = new Map<string, number>();
    for (const filename of ["tcp", "tcp6"]) {
      let output: Buffer;
      try { output = await readFile(`/proc/net/${filename}`); }
      catch (error) { if (filename === "tcp6" && missing(error)) continue; throw inspectionError(); }
      const lines = output.toString("utf8").trim().split(/\r?\n/);
      if (!lines[0]?.includes("local_address")) throw inspectionError();
      for (const line of lines.slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) throw inspectionError();
        if (fields[3] !== "0A") continue;
        const port = Number.parseInt(fields[1].split(":")[1] ?? "", 16);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^\d+$/.test(fields[9]) || fields[9] === "0") throw inspectionError();
        inodePorts.set(fields[9], port);
      }
    }
    if (!inodePorts.size) return [];
    const owners: ProcessPortListener[] = [], found = new Set<string>();
    for (const record of processes) {
      let descriptors: string[];
      try { descriptors = await readdir(`/proc/${record.pid}/fd`); } catch { continue; }
      for (const fd of descriptors.filter((entry) => /^\d+$/.test(entry))) {
        let target: string;
        try { target = await readlink(`/proc/${record.pid}/fd/${fd}`); } catch { continue; }
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        const port = inode ? inodePorts.get(inode) : undefined;
        if (inode && port !== undefined) { found.add(inode); owners.push({ port, pid: record.pid }); }
      }
    }
    if (found.size !== inodePorts.size) throw inspectionError();
    return [...new Map(owners.map((owner) => [`${owner.port}:${owner.pid}`, owner])).values()]
      .sort((a, b) => a.port - b.port || a.pid - b.pid);
  }

  return {
    async snapshot(port) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw inspectionError();
      try {
        const processes = await enumerate();
        const [portListeners, listenerOwners] = await Promise.all([
          listeners(port, processes), allListenerOwners(processes),
        ]);
        return { processes, listeners: portListeners, listenerOwners };
      } catch { throw inspectionError(); }
    },
    async terminate(record) {
      if (!pidValid(record.pid) || !record.startId || !record.executable || !record.argv?.length) throw identityError();
      const expected = { ...record, argv: [...record.argv] };
      let observed: ProcessRecord | undefined | null;
      try { observed = platform === "linux" ? await linuxRecord(expected.pid) : (await enumerate()).find((p) => p.pid === expected.pid); }
      catch { throw identityError(); }
      if (!observed) return;
      if (observed.startId !== expected.startId || observed.executable !== expected.executable || observed.parentPid !== expected.parentPid || observed.cwd !== expected.cwd || !observed.argv || observed.argv.length !== expected.argv.length || observed.argv.some((arg, i) => arg !== expected.argv[i])) throw identityError();
      try {
        if (platform === "win32") await runner("taskkill.exe", ["/PID", String(expected.pid), "/F"]);
        else signal(expected.pid, "SIGTERM");
      } catch (error) { if (!missing(error)) throw new Error("Verified process termination failed."); }
    },
  };
}
