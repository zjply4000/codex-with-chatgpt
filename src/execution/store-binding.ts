import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export interface ExecutionStoreBinding {
  workspaceId: string;
  stateStoreFingerprint: string;
  updatedAt: string;
}

function bindingFile(workspaceId: string): string {
  return path.join(getStateDir(), "execution-store-bindings", `${workspaceId}.json`);
}

export function readExecutionStoreBinding(workspaceId: string): ExecutionStoreBinding | null {
  const value = readJsonIfExists<Partial<ExecutionStoreBinding>>(bindingFile(workspaceId));
  if (!value || value.workspaceId !== workspaceId || !/^[0-9a-f]{16}$/.test(value.stateStoreFingerprint ?? "") ||
    typeof value.updatedAt !== "string") return null;
  return value as ExecutionStoreBinding;
}

export function writeExecutionStoreBinding(workspaceId: string, stateStoreFingerprint: string): void {
  if (!/^[0-9a-f]{16}$/.test(stateStoreFingerprint)) throw new Error("Invalid execution store fingerprint.");
  writeSecureJson(bindingFile(workspaceId), {
    workspaceId,
    stateStoreFingerprint,
    updatedAt: new Date().toISOString(),
  } satisfies ExecutionStoreBinding);
}
