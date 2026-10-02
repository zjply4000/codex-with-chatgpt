import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getStateDir } from "../config/paths.js";

function lockFile(workspaceId: string): string {
  return path.join(getStateDir(), "maintenance", `${workspaceId}.lock`);
}

export function assertMaintenanceAccess(workspaceId: string, token?: string): void {
  const file = lockFile(workspaceId);
  if (!fs.existsSync(file)) return;
  if (!token || fs.readFileSync(file, "utf8") !== token) {
    throw new Error("Bridge maintenance is in progress; refusing concurrent start or stop.");
  }
}

export function acquireMaintenance(workspaceId: string): { token: string; release(): void } {
  const file = lockFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
  return { token, release: () => {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file);
  } };
}
