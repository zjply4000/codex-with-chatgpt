import { afterEach, expect, it, vi } from "vitest";
import { probeMcp, probePublicBridge } from "../src/bridge/verify.js";

afterEach(() => vi.unstubAllGlobals());

it("accepts only the expected workspace and instance through the public endpoint", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    service: "c2c-bridge", status: "ok", workspaceId: "expected", instanceId: "current",
  }))));
  expect((await probePublicBridge("https://bridge.example", "expected", "current")).ok).toBe(true);
  expect((await probePublicBridge("https://bridge.example", "other", "current")).ok).toBe(false);
  expect((await probePublicBridge("https://bridge.example", "expected", "old")).ok).toBe(false);
});

it("requires unauthenticated MCP requests to return 401", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  expect((await probeMcp(12345)).ok).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  expect((await probeMcp(12345)).ok).toBe(false);
});
