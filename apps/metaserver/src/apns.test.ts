import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";

import { ApnsSender, signApnsJwt } from "./apns.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function fakeApns(respond: (path: string) => { status: number; body?: string }) {
  const seen: Array<{ headers: NodeHttp2.IncomingHttpHeaders; body: string }> = [];
  const server = NodeHttp2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => {
      seen.push({ headers, body });
      const reply = respond(String(headers[":path"]));
      stream.respond({ ":status": reply.status });
      stream.end(reply.body ?? "");
    });
  });
  return new Promise<{ origin: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        origin: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
        seen,
        close: () => server.close(),
      }),
    ),
  );
}

describe("ApnsSender", () => {
  it("signs a JWT that verifies with the key's public half", () => {
    const jwt = signApnsJwt({ keyPem, keyId: "KEY123", teamId: "TEAM123" }, 1_700_000_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: "TEAM123",
      iat: 1_700_000_000,
    });
    const valid = NodeCrypto.verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    );
    expect(valid).toBe(true);
  });

  it("posts a time-sensitive alert and reports dead tokens", async () => {
    const apns = await fakeApns((path) =>
      path.endsWith("/dead") ? { status: 410, body: '{"reason":"Unregistered"}' } : { status: 200 },
    );
    const sender = new ApnsSender({
      keyPem,
      keyId: "KEY123",
      teamId: "TEAM123",
      topic: "io.example.app",
      origin: apns.origin,
    });
    try {
      const ok = await sender.send("abc", {
        title: "Approval needed",
        body: "host-a wants to run a command",
        data: { threadId: "t1" },
        timeSensitive: true,
      });
      expect(ok).toEqual({ ok: true });
      const first = apns.seen[0]!;
      expect(first.headers[":path"]).toBe("/3/device/abc");
      expect(first.headers["apns-topic"]).toBe("io.example.app");
      expect(String(first.headers.authorization)).toMatch(/^bearer /);
      expect(JSON.parse(first.body)).toEqual({
        aps: {
          alert: { title: "Approval needed", body: "host-a wants to run a command" },
          sound: "default",
          "interruption-level": "time-sensitive",
        },
        threadId: "t1",
      });

      const dead = await sender.send("dead", { title: "x", body: "y" });
      expect(dead).toEqual({ ok: false, status: 410, reason: "Unregistered", unregistered: true });
    } finally {
      sender.close();
      apns.close();
    }
  });
});
