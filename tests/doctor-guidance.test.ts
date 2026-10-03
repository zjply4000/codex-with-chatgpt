import { describe, expect, it } from "vitest";
import { bridgeRuntimeMismatchGuidance } from "../src/cli/doctor-guidance.js";

describe("doctor Bridge runtime mismatch guidance", () => {
  it("recommends restarting the workspace Bridge and its configured Named Tunnel", () => {
    const guidance = bridgeRuntimeMismatchGuidance("D:\\Projects\\sfgcdnhb", true);

    expect(guidance).toContain('c2c restart -w "D:\\Projects\\sfgcdnhb" --tunnel');
    expect(guidance).not.toMatch(/doctor|Connector|OAuth|运行记录.*安全重启/);
  });

  it("does not enable a tunnel for local-only workspaces", () => {
    const guidance = bridgeRuntimeMismatchGuidance("D:\\Projects\\local workspace", false);

    expect(guidance).toContain('c2c restart -w "D:\\Projects\\local workspace"');
    expect(guidance).not.toContain("--tunnel");
    expect(guidance).toHaveLength(guidance.trim().length);
  });
});
