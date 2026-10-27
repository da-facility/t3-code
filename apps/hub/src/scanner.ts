import * as NodeChildProcess from "node:child_process";

import { parseScan, SCAN_SCRIPT } from "@t3tools/fleet/scan";
import type { RegistryServer } from "@t3tools/fleet/registry";

import type { HubDb } from "./db.ts";

export interface ScanOptions {
  /** The hub's own SSH private key. */
  identityFile: string;
  knownHostsFile: string;
  timeoutMs?: number;
}

export function sshArgs(server: RegistryServer, options: ScanOptions) {
  return [
    "-i",
    options.identityFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${options.knownHostsFile}`,
    "-p",
    String(server.port),
    server.user ? `${server.user}@${server.address}` : server.address,
    "sh -s",
  ];
}

function runSsh(args: string[], stdin: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

/** Scans one host read-only and replaces its services. Never throws; errors land on the server row. */
export async function scanServer(db: HubDb, server: RegistryServer, options: ScanOptions) {
  const result = await runSsh(sshArgs(server, options), SCAN_SCRIPT, options.timeoutMs ?? 60_000);
  if (!result.stdout.includes("@@fleet:end")) {
    const error = (result.stderr.trim() || `ssh exited with ${result.code}`)
      .split("\n")
      .slice(-3)
      .join(" ");
    db.replaceServices(server.id, [], error);
    return { serverId: server.id, ok: false as const, error, services: 0 };
  }
  const services = parseScan(server.id, result.stdout, new Date().toISOString());
  db.replaceServices(server.id, services, null);
  return { serverId: server.id, ok: true as const, error: null, services: services.length };
}
