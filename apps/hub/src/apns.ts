import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

export interface ApnsConfig {
  /** Contents of the `.p8` auth key from the Apple developer account. */
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
  /** `https://api.push.apple.com` or `https://api.sandbox.push.apple.com`. */
  origin: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Free-form routing data for the app (server id, thread id, request id). */
  data?: Record<string, string>;
  /** Pending approvals break through Focus; turn completions do not. */
  timeSensitive?: boolean;
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function signApnsJwt(config: Pick<ApnsConfig, "keyPem" | "keyId" | "teamId">, now: number) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: config.keyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

export function apnsPayload(message: PushMessage) {
  return {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: "default",
      "interruption-level": message.timeSensitive ? "time-sensitive" : "active",
    },
    ...message.data,
  };
}

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      reason: string;
      /** The token is dead; drop it. */ unregistered: boolean;
    };

/** One HTTP/2 session per sender; APNs JWTs are reused for up to an hour. */
export class ApnsSender {
  private session: NodeHttp2.ClientHttp2Session | null = null;
  private jwt: { token: string; issuedAt: number } | null = null;

  private readonly config: ApnsConfig;
  private readonly now: () => number;

  constructor(config: ApnsConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  private token() {
    const now = this.now();
    if (!this.jwt || now - this.jwt.issuedAt > 50 * 60_000) {
      this.jwt = { token: signApnsJwt(this.config, now), issuedAt: now };
    }
    return this.jwt.token;
  }

  private connect() {
    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = NodeHttp2.connect(this.config.origin);
      this.session.on("error", () => {
        this.session = null;
      });
      this.session.unref();
    }
    return this.session;
  }

  send(deviceToken: string, message: PushMessage): Promise<PushResult> {
    const body = JSON.stringify(apnsPayload(message));
    return new Promise((resolve) => {
      const request = this.connect().request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        text += chunk;
      });
      request.on("end", () => {
        if (status === 200) return resolve({ ok: true });
        let reason = text;
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? text;
        } catch {}
        resolve({
          ok: false,
          status,
          reason,
          unregistered: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
        });
      });
      request.on("error", (error) =>
        resolve({ ok: false, status: 0, reason: error.message, unregistered: false }),
      );
      request.end(body);
    });
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}
