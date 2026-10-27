import type { RegistryService } from "./registry.ts";

/**
 * The host scan runs one read-only shell script over SSH and parses its
 * sectioned output. Sections are delimited by `@@fleet:<name>` lines so a
 * missing tool (no docker, no brew) only empties its own section.
 */
export const SCAN_SCRIPT = String.raw`
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/sbin"
echo "@@fleet:uname"; uname -s
if command -v docker >/dev/null 2>&1; then
  echo "@@fleet:docker"
  ids=$(docker ps -aq 2>/dev/null)
  [ -n "$ids" ] && docker inspect $ids 2>/dev/null
fi
if command -v systemctl >/dev/null 2>&1; then
  echo "@@fleet:systemd"
  systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null
  echo "@@fleet:systemd-files"
  systemctl show --type=service --all -p Id -p FragmentPath 2>/dev/null
fi
if command -v brew >/dev/null 2>&1; then
  echo "@@fleet:brew"
  brew services list --json 2>/dev/null
fi
if command -v launchctl >/dev/null 2>&1; then
  echo "@@fleet:launchd"
  for dir in /Library/LaunchDaemons /Library/LaunchAgents "$HOME/Library/LaunchAgents"; do
    [ -d "$dir" ] && ls -1 "$dir"/*.plist 2>/dev/null
  done
  echo "@@fleet:launchd-list"
  launchctl list 2>/dev/null
fi
echo "@@fleet:end"
`;

export function splitSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const header = /^@@fleet:(\S+)$/.exec(line);
    if (header) {
      if (name) sections.set(name, lines.join("\n"));
      name = header[1]!;
      lines = [];
    } else if (name) {
      lines.push(line);
    }
  }
  if (name && name !== "end") sections.set(name, lines.join("\n"));
  return sections;
}

interface DockerInspect {
  Name?: string;
  State?: { Status?: string };
  Config?: { Image?: string; Labels?: Record<string, string> | null };
}

const parseJson = <T>(text: string | undefined, fallback: T): T => {
  if (!text || text.trim().length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** Builtin units that are noise for "where is X running" questions. */
const SYSTEMD_NOISE =
  /^(systemd-|user@|user-runtime-dir@|getty@|serial-getty@|modprobe@|dbus|polkit|snap|ssh|cron|rsyslog|ufw|apparmor|cloud-|networkd-dispatcher|unattended-upgrades|multipathd|udisks2|packagekit|setvtrgb|keyboard-setup|console-setup|kmod|plymouth|finalrd|blk-availability|lvm2|e2scrub|fstrim|grub|motd|apport|irqbalance|thermald|fwupd|ModemManager|NetworkManager|wpa_supplicant|accounts-daemon|avahi|bluetooth|cups|gdm|rtkit|upower|emergency|rescue|initrd|dm-event|open-iscsi|iscsid|secureboot|lxd|ua-|ubuntu-|pollinate|serial|sysstat|man-db|logrotate|apt-|dpkg|e2fsprogs|getty|sshd|chrony|qemu-guest|hv-|vgauth|open-vm)/;

export function parseScan(serverId: string, output: string, scannedAt: string): RegistryService[] {
  const sections = splitSections(output);
  const services: RegistryService[] = [];

  for (const container of parseJson<DockerInspect[]>(sections.get("docker"), [])) {
    const labels = container.Config?.Labels ?? {};
    const composeFiles = labels["com.docker.compose.project.config_files"];
    services.push({
      serverId,
      kind: "docker",
      name: (container.Name ?? "").replace(/^\//, ""),
      status: container.State?.Status ?? null,
      image: container.Config?.Image ?? null,
      composeDir: labels["com.docker.compose.project.working_dir"] ?? null,
      configFiles: composeFiles ? composeFiles.split(",").filter(Boolean) : [],
      scannedAt,
    });
  }

  const fragments = new Map<string, string>();
  let pendingId: string | null = null;
  for (const line of (sections.get("systemd-files") ?? "").split("\n")) {
    if (line.startsWith("Id=")) pendingId = line.slice(3);
    else if (line.startsWith("FragmentPath=") && pendingId) {
      const path = line.slice("FragmentPath=".length);
      if (path) fragments.set(pendingId, path);
    }
  }
  for (const line of (sections.get("systemd") ?? "").split("\n")) {
    const [unit, , active, sub] = line.trim().split(/\s+/);
    if (!unit || !unit.endsWith(".service") || SYSTEMD_NOISE.test(unit)) continue;
    const fragment = fragments.get(unit);
    // Units shipped by the distro live under /usr/lib or /lib; admin-installed ones under /etc.
    if (fragment && /^\/(usr\/)?lib\//.test(fragment) && sub !== "running") continue;
    services.push({
      serverId,
      kind: "systemd",
      name: unit.replace(/\.service$/, ""),
      status: sub ?? active ?? null,
      image: null,
      composeDir: null,
      configFiles: fragment ? [fragment] : [],
      scannedAt,
    });
  }

  for (const entry of parseJson<Array<{ name?: string; status?: string; file?: string | null }>>(
    sections.get("brew"),
    [],
  )) {
    if (!entry.name) continue;
    services.push({
      serverId,
      kind: "brew",
      name: entry.name,
      status: entry.status ?? null,
      image: null,
      composeDir: null,
      configFiles: entry.file ? [entry.file] : [],
      scannedAt,
    });
  }

  const loaded = new Map<string, string>();
  for (const line of (sections.get("launchd-list") ?? "").split("\n")) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label && label !== "Label") loaded.set(label, pid === "-" ? "loaded" : "running");
  }
  for (const plist of (sections.get("launchd") ?? "").split("\n")) {
    const path = plist.trim();
    if (!path.endsWith(".plist")) continue;
    const label = path
      .split("/")
      .pop()!
      .replace(/\.plist$/, "");
    if (label.startsWith("com.apple.")) continue;
    services.push({
      serverId,
      kind: "launchd",
      name: label,
      status: loaded.get(label) ?? "not loaded",
      image: null,
      composeDir: null,
      configFiles: [path],
      scannedAt,
    });
  }

  return services;
}
