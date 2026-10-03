import { describe, expect, it } from "vitest";
import { parseTunnelInfoConnectorCount } from "../src/tunnel/remote-connectors.js";

describe("read-only remote Tunnel connector inspection", () => {
  it("counts connector rows without returning connector IDs or origin details", () => {
    const output = `NAME: c2c-test
ID: 11111111-1111-4111-8111-111111111111
CONNECTOR ID                         CREATED              ARCHITECTURE  VERSION  ORIGIN IP    EDGE
22222222-2222-4222-8222-222222222222 2026-10-03T12:00:00Z windows_amd64 2026.9.3 192.0.2.1 1abc
33333333-3333-4333-8333-333333333333 2026-10-03T12:01:00Z windows_amd64 2026.9.3 192.0.2.2 2def
`;
    expect(parseTunnelInfoConnectorCount(output)).toBe(2);
    expect(parseTunnelInfoConnectorCount("No connector table available")).toBeNull();
  });
});
