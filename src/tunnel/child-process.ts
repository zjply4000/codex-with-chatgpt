import type { ChildProcess } from "node:child_process";

const stoppingChildren = new WeakMap<ChildProcess, Promise<void>>();

function hasExited(child: ChildProcess): boolean {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited || hasExited(child));
    };
    const onExit = (): void => finish(true);
    const onError = (): void => { if (hasExited(child)) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.on("error", onError);
  });
}

/** Stop only the exact ChildProcess this provider spawned, and wait until it is gone. */
export function stopOwnedChildProcess(
  child: ChildProcess,
  options: { graceMs?: number; escalationMs?: number } = {}
): Promise<void> {
  const inFlight = stoppingChildren.get(child);
  if (inFlight) return inFlight;
  if (hasExited(child)) return Promise.resolve();
  const stopping = stopChildProcess(child, options);
  stoppingChildren.set(child, stopping);
  void stopping.then(
    () => { if (stoppingChildren.get(child) === stopping) stoppingChildren.delete(child); },
    () => { if (stoppingChildren.get(child) === stopping) stoppingChildren.delete(child); }
  );
  return stopping;
}

async function stopChildProcess(
  child: ChildProcess,
  options: { graceMs?: number; escalationMs?: number }
): Promise<void> {
  if (hasExited(child)) return;
  const graceMs = options.graceMs ?? 5_000;
  const escalationMs = options.escalationMs ?? 2_000;
  const gracefulExit = waitForExit(child, graceMs);
  try { child.kill("SIGTERM"); }
  catch { /* The exit wait below distinguishes an exited process from a live one. */ }
  if (await gracefulExit) return;
  if (hasExited(child)) return;
  const forcedExit = waitForExit(child, escalationMs);
  let sent = false;
  try { sent = child.kill("SIGKILL"); }
  catch { /* Report failure after the bounded exit wait. */ }
  if (!sent && !hasExited(child)) throw new Error("CLOUDFLARED_STOP_FAILED: could not signal the owned process.");
  if (!await forcedExit) throw new Error("CLOUDFLARED_STOP_TIMEOUT: the owned process did not exit after termination.");
}
