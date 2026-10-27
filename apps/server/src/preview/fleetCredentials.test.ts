import { describe, expect, it } from "@effect/vitest";

import { fleetHubConfig, hubCredentialSource, makeAskGate } from "./fleetCredentials.ts";

describe("fleet credentials", () => {
  it("is off unless both the hub URL and token are set", () => {
    expect(fleetHubConfig({})).toBeNull();
    expect(fleetHubConfig({ FLEET_HUB_URL: "http://hub:8780/" })).toBeNull();
    expect(fleetHubConfig({ FLEET_HUB_URL: "http://hub:8780/", FLEET_HUB_TOKEN: "t" })).toEqual({
      url: "http://hub:8780",
      token: "t",
    });
  });

  it("prompts the phone once per site per window, and never for non-web pages", () => {
    let now = 0;
    const gate = makeAskGate(() => now);
    expect(gate("https://example.com/login")).toBe(true);
    expect(gate("https://example.com/other")).toBe(false);
    expect(gate("https://other.example.com/")).toBe(true);
    expect(gate("data:text/html,x")).toBe(false);
    expect(gate("about:blank")).toBe(false);
    now += 2 * 60_000 + 1;
    expect(gate("https://example.com/login")).toBe(true);
  });

  it("asks the hub with the fleet token and treats a refusal as no credential", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify(status === 200 ? { username: "alice", password: "pw" } : { error: "no" }),
        {
          status,
        },
      );
    }) as unknown as typeof fetch;
    const source = hubCredentialSource({ url: "http://hub:8780", token: "fleet_x" }, fakeFetch);
    expect(await source("https://example.com/login")).toEqual({
      username: "alice",
      password: "pw",
    });
    expect(calls[0]!.url).toBe("http://hub:8780/credentials");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer fleet_x");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ url: "https://example.com/login" });
    status = 403;
    expect(await source("https://example.com/login")).toBeNull();
  });
});
