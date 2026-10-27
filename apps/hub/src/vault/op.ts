import * as NodeChildProcess from "node:child_process";

/**
 * The 1Password CLI as the hub uses it: manual sign-in with the master
 * password on stdin, a session token held in memory, and `op signout`
 * (never `--forget`, which would make the next sign-in a new device and ask
 * for the second factor again).
 */

export interface OpLogin {
  id: string;
  title: string;
  urls: string[];
}

export interface OpCredential {
  id: string;
  title: string;
  username: string | null;
  password: string | null;
}

export class OpError extends Error {}

export class OpCli {
  readonly bin: string;
  readonly account: string | null;
  readonly env: NodeJS.ProcessEnv;

  constructor(bin: string, account: string | null, env: NodeJS.ProcessEnv = process.env) {
    this.bin = bin;
    this.account = account;
    this.env = env;
  }

  private run(args: string[], input?: string, timeoutMs = 30_000) {
    return new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(this.bin, args, {
        env: { ...this.env, OP_FORMAT: "json" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new OpError(`Could not run op: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new OpError(
              stderr.trim().replace(/^\[ERROR\]\s+\S+\s+\S+\s+/, "") || `op exited with ${code}`,
            ),
          );
      });
      child.stdin.end(input ?? "");
    });
  }

  private accountArgs() {
    return this.account ? ["--account", this.account] : [];
  }

  async signin(password: string): Promise<string> {
    const token = (
      await this.run(["signin", "--raw", ...this.accountArgs()], `${password}\n`)
    ).trim();
    if (!token) throw new OpError("op signin returned no session token");
    return token;
  }

  async signout() {
    await this.run(["signout", ...this.accountArgs()]).catch(() => {});
  }

  async logins(session: string): Promise<OpLogin[]> {
    const raw = JSON.parse(
      await this.run([
        "item",
        "list",
        "--categories",
        "Login",
        "--format",
        "json",
        "--session",
        session,
        ...this.accountArgs(),
      ]),
    ) as Array<{ id: string; title: string; urls?: Array<{ href: string }> }>;
    return raw.map((item) => ({
      id: item.id,
      title: item.title,
      urls: (item.urls ?? []).map((url) => url.href),
    }));
  }

  async credential(session: string, id: string): Promise<OpCredential> {
    const raw = JSON.parse(
      await this.run([
        "item",
        "get",
        id,
        "--format",
        "json",
        "--reveal",
        "--session",
        session,
        ...this.accountArgs(),
      ]),
    ) as {
      id: string;
      title: string;
      fields?: Array<{ id?: string; purpose?: string; value?: string }>;
    };
    const field = (purpose: string) =>
      raw.fields?.find(
        (candidate) => candidate.purpose === purpose || candidate.id === purpose.toLowerCase(),
      )?.value ?? null;
    return {
      id: raw.id,
      title: raw.title,
      username: field("USERNAME"),
      password: field("PASSWORD"),
    };
  }
}

/** Logins whose saved URL is on the same site as `url` (host or a parent domain). */
export function matchLogins(logins: OpLogin[], url: string): OpLogin[] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  return logins.filter((login) =>
    login.urls.some((saved) => {
      try {
        const savedHost = new URL(
          saved.includes("://") ? saved : `https://${saved}`,
        ).hostname.toLowerCase();
        return (
          host === savedHost || host.endsWith(`.${savedHost}`) || savedHost.endsWith(`.${host}`)
        );
      } catch {
        return false;
      }
    }),
  );
}
