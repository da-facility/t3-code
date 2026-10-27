import type { RegistryServerInput, ServerSource } from "./registry.ts";

/**
 * Pure parsers for the one-off registry import. They read text the caller
 * supplies (an ssh config, `tailscale status --json`, Ansible inventories) and
 * return proposed rows; nothing here touches the filesystem or the network.
 */

export interface ImportedServer {
  id: string;
  address: string;
  user: string | null;
  port: number;
  keyName: string | null;
  tags: string[];
  sources: ServerSource[];
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const shortName = (value: string) => slug(value.split(".")[0] ?? value);

const basename = (path: string) => path.replace(/\\/g, "/").split("/").pop() ?? path;

export function parseSshConfig(text: string): ImportedServer[] {
  const blocks: Array<{ patterns: string[]; options: Map<string, string> }> = [];
  let current: { patterns: string[]; options: Map<string, string> } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      current = { patterns: value.split(/\s+/), options: new Map() };
      blocks.push(current);
    } else if (key === "match") {
      current = null;
    } else if (current && !current.options.has(key)) {
      current.options.set(key, value);
    }
  }

  const servers: ImportedServer[] = [];
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (/[*?!]/.test(pattern)) continue;
      const identity = block.options.get("identityfile");
      servers.push({
        id: slug(pattern),
        address: block.options.get("hostname") ?? pattern,
        user: block.options.get("user") ?? null,
        port: Number(block.options.get("port") ?? 22) || 22,
        keyName: identity ? basename(identity) : null,
        tags: [],
        sources: ["ssh-config"],
      });
    }
  }
  return servers;
}

interface TailscalePeer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Tags?: string[];
}

export function parseTailscaleStatus(json: string): ImportedServer[] {
  const status = JSON.parse(json) as { Self?: TailscalePeer; Peer?: Record<string, TailscalePeer> };
  const peers = Object.values(status.Peer ?? {});
  const servers: ImportedServer[] = [];
  for (const peer of peers) {
    const os = (peer.OS ?? "").toLowerCase();
    // Phones and tablets are not SSH targets.
    if (os === "ios" || os === "android") continue;
    const dnsName = peer.DNSName?.replace(/\.$/, "");
    const address = dnsName || peer.TailscaleIPs?.[0];
    const name = peer.HostName || dnsName;
    if (!address || !name) continue;
    servers.push({
      id: shortName(name),
      address,
      user: null,
      port: 22,
      keyName: null,
      tags: [...(os ? [os] : []), ...(peer.Tags ?? []).map((tag) => tag.replace(/^tag:/, ""))],
      sources: ["tailscale"],
    });
  }
  return servers;
}

/** INI-style Ansible inventory. Group names become tags. */
export function parseAnsibleIni(text: string): ImportedServer[] {
  const byId = new Map<string, ImportedServer>();
  let group: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (line.length === 0) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const name = header[1]!;
      group = name.includes(":") ? null : name;
      continue;
    }
    if (group === null) continue;
    const [host, ...vars] = line.split(/\s+/);
    if (!host) continue;
    const options = new Map(
      vars.flatMap((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [[pair.slice(0, index), pair.slice(index + 1)] as const] : [];
      }),
    );
    const id = slug(host);
    const existing = byId.get(id);
    const tags = group === "all" || group === "ungrouped" ? [] : [group];
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...tags])];
      continue;
    }
    const key = options.get("ansible_ssh_private_key_file");
    byId.set(id, {
      id,
      address: options.get("ansible_host") ?? host,
      user: options.get("ansible_user") ?? options.get("ansible_ssh_user") ?? null,
      port: Number(options.get("ansible_port") ?? 22) || 22,
      keyName: key ? basename(key) : null,
      tags,
      sources: ["ansible"],
    });
  }
  return [...byId.values()];
}

/**
 * Merges rows that describe the same machine. Rows match on id or on address;
 * the first source that supplies a field wins, so callers pass the most
 * authoritative source (the ssh config) first.
 */
export function mergeImported(...lists: ImportedServer[][]): RegistryServerInput[] {
  const merged: ImportedServer[] = [];
  for (const server of lists.flat()) {
    const match = merged.find(
      (candidate) =>
        candidate.id === server.id ||
        candidate.address === server.address ||
        shortName(candidate.address) === server.id ||
        candidate.id === shortName(server.address),
    );
    if (!match) {
      merged.push({ ...server, tags: [...server.tags], sources: [...server.sources] });
      continue;
    }
    match.user ??= server.user;
    match.keyName ??= server.keyName;
    if (match.port === 22 && server.port !== 22) match.port = server.port;
    match.tags = [...new Set([...match.tags, ...server.tags])];
    match.sources = [...new Set([...match.sources, ...server.sources])];
  }
  return merged.map((server) => ({ ...server }));
}
