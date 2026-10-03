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

it("requires three uncached public health probes to agree on the Bridge instance", async () => {
  let probe = 0;
  const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => {
    probe++;
    const instanceId = probe === 2 ? "other-replica" : "current";
    return new Response(JSON.stringify({
      service: "c2c-bridge", status: "ok", workspaceId: "expected", instanceId,
    }));
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await probePublicBridge("https://bridge.example", "expected", "current");

  expect(result).toMatchObject({ ok: false, detail: "PUBLIC_INSTANCE_MISMATCH" });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
  expect(urls.every((url) => url.pathname === "/health" && url.searchParams.has("c2c_instance_probe"))).toBe(true);
  expect(new Set(urls.map((url) => url.searchParams.get("c2c_instance_probe"))).size).toBe(3);
  expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("cache-control") === "no-cache")).toBe(true);
});

it("requires unauthenticated MCP requests to return 401", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  expect((await probeMcp(12345)).ok).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  expect((await probeMcp(12345)).ok).toBe(false);
});
