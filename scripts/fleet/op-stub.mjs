#!/usr/bin/env node
// Stand-in for the 1Password `op` CLI (account add, signin --raw, signout, whoami, item list/get)
// with op's 30-minute idle session expiry. State: $OP_STUB_HOME/state.json (default ~/.op-stub).
// Seed logins: op-stub.mjs __seed '[{"title":"Example","url":"https://example.com","username":"u","password":"p"}]'
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const IDLE_MS = Number(process.env.OP_STUB_IDLE_MS ?? 30 * 60_000);
const home = process.env.OP_STUB_HOME ?? NodePath.join(NodeOS.homedir(), ".op-stub");
const statePath = NodePath.join(home, "state.json");

const load = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
  } catch {
    return { accounts: [], sessions: [], items: [], deviceRegistrations: 0 };
  }
};
const save = (state) => {
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
};
const fail = (message, code = 1) => {
  process.stderr.write(
    `[ERROR] ${new Date().toISOString().slice(0, 19).replace("T", " ")} ${message}\n`,
  );
  process.exit(code);
};
const readStdin = () => {
  try {
    return NodeFS.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  } catch {
    return "";
  }
};
const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : true;
};
const positional = args.filter(
  (arg, index) =>
    !arg.startsWith("--") &&
    !(
      index > 0 &&
      args[index - 1].startsWith("--") &&
      !["--raw", "--reveal", "--forget"].includes(args[index - 1])
    ),
);

const state = load();
const now = Date.now();

function account(shorthand) {
  if (state.accounts.length === 0) fail("No accounts configured for use with 1Password CLI.");
  const found = shorthand
    ? state.accounts.find((a) => a.shorthand === shorthand || a.address === shorthand)
    : state.accounts[0];
  if (!found) fail(`no account found for filter ${shorthand}`);
  return found;
}

function session() {
  const token =
    flag("session") ??
    Object.entries(process.env).find(([key]) => key.startsWith("OP_SESSION_"))?.[1];
  if (typeof token !== "string")
    fail("You are not currently signed in. Please run `op signin --help` for instructions");
  const entry = state.sessions.find((candidate) => candidate.tokenHash === hash(token));
  if (!entry || now - entry.lastUsed > IDLE_MS) {
    state.sessions = state.sessions.filter((candidate) => candidate !== entry);
    save(state);
    fail("You are not currently signed in. Please run `op signin --help` for instructions");
  }
  entry.lastUsed = now;
  save(state);
  return entry;
}

const [command, sub] = positional;

if (command === "__seed") {
  state.items = JSON.parse(sub ?? "[]").map((item, index) => ({
    id: item.id ?? `item${index + 1}`,
    ...item,
  }));
  save(state);
  process.exit(0);
}

if (command === "account" && sub === "add") {
  const address = flag("address");
  const email = flag("email");
  const secretKey = flag("secret-key");
  if (typeof address !== "string" || typeof email !== "string" || typeof secretKey !== "string") {
    fail("account add needs --address, --email and --secret-key");
  }
  const password = readStdin();
  if (!password) fail("a password is required");
  const shorthand = flag("shorthand") ?? address.split(".")[0];
  state.accounts = state.accounts.filter((a) => a.shorthand !== shorthand);
  // A new device registration is where 1Password asks for the second factor.
  state.accounts.push({
    shorthand,
    address,
    email,
    passwordHash: hash(password),
    userId: hash(email).slice(0, 26).toUpperCase(),
  });
  state.deviceRegistrations += 1;
  save(state);
  process.stdout.write(`Now run 'eval $(op signin --account ${shorthand})' to sign in.\n`);
  process.exit(0);
}

if (command === "signin") {
  const target = account(typeof flag("account") === "string" ? flag("account") : undefined);
  const password = readStdin();
  if (hash(password) !== target.passwordHash)
    fail("(401) Unauthorized: You aren't authorized to perform this action.");
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  state.sessions.push({ tokenHash: hash(token), account: target.shorthand, lastUsed: now });
  save(state);
  process.stdout.write(
    flag("raw") ? `${token}\n` : `export OP_SESSION_${target.shorthand}="${token}"\n`,
  );
  process.exit(0);
}

if (command === "signout") {
  const target = account(typeof flag("account") === "string" ? flag("account") : undefined);
  state.sessions = state.sessions.filter((entry) => entry.account !== target.shorthand);
  if (flag("forget")) state.accounts = state.accounts.filter((a) => a !== target);
  save(state);
  process.exit(0);
}

if (command === "whoami") {
  const entry = session();
  const target = account(entry.account);
  process.stdout.write(
    `${JSON.stringify({ url: target.address, email: target.email, user_uuid: target.userId, account_uuid: target.shorthand })}\n`,
  );
  process.exit(0);
}

if (command === "item" && sub === "list") {
  session();
  process.stdout.write(
    `${JSON.stringify(
      state.items.map((item) => ({
        id: item.id,
        title: item.title,
        category: "LOGIN",
        urls: item.url ? [{ primary: true, href: item.url }] : [],
      })),
    )}\n`,
  );
  process.exit(0);
}

if (command === "item" && sub === "get") {
  session();
  const id = positional[2];
  const item = state.items.find((candidate) => candidate.id === id || candidate.title === id);
  if (!item) fail(`"${id}" isn't an item in any vault.`);
  process.stdout.write(
    `${JSON.stringify({
      id: item.id,
      title: item.title,
      category: "LOGIN",
      urls: item.url ? [{ primary: true, href: item.url }] : [],
      fields: [
        {
          id: "username",
          label: "username",
          purpose: "USERNAME",
          type: "STRING",
          value: item.username,
        },
        {
          id: "password",
          label: "password",
          purpose: "PASSWORD",
          type: "CONCEALED",
          value: item.password,
        },
        ...(item.totp
          ? [{ id: "totp", label: "one-time password", type: "OTP", totp: "123456" }]
          : []),
      ],
    })}\n`,
  );
  process.exit(0);
}

if (command === "--version" || flag("version")) {
  process.stdout.write("2.31.0-stub\n");
  process.exit(0);
}

fail(`unknown command: ${args.join(" ")}`);
