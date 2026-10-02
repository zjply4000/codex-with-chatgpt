import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(checkout, "src/cli/index.ts");

it("exposes recovery and dry-run help without a force bypass", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "bridge", "recover", "--help"], { encoding: "utf8", cwd: checkout });
  expect(result.status).toBe(0); expect(result.stdout).toContain("--dry-run");
  expect(result.stdout).toContain("--workspace"); expect(result.stdout).toContain("--json");
  expect(result.stdout).not.toContain("--force");
});

it("uses cwd by default and keeps an absent runtime directory absent on dry-run", () => {
  const root = makeTmpDir("recover-cli-root"), state = makeTmpDir("recover-cli-state");
  try {
    const before = fs.readdirSync(state);
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "bridge", "recover", "--dry-run", "--json"], {
      encoding: "utf8", cwd: root, env: { ...process.env, C2C_STATE_DIR: state },
    });
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, dryRun: true, canRecover: false, plan: { workspace: fs.realpathSync.native(root), observation: { state: "stopped" } } });
    expect(fs.readdirSync(state)).toEqual(before);
  } finally { cleanup(root); cleanup(state); }
});
