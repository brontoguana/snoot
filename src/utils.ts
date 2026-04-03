import { resolve, delimiter as PATH_DELIMITER } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import type { EndpointConfig } from "./types.js";

const GLOBAL_SNOOT_DIR = resolve(homedir(), ".snoot");

const IS_WINDOWS = process.platform === "win32";

// Find the full path to a CLI tool (claude or gemini).
// On Windows, Bun.spawn doesn't resolve .cmd/.bat extensions, so we search explicitly.
export function findCliPath(name: string): string | undefined {
  const extensions = IS_WINDOWS ? [".cmd", ".bat", ".exe", ""] : [""];
  const pathDirs = (process.env.PATH || "").split(PATH_DELIMITER);

  // Also search common install locations not always in PATH
  const extraDirs: string[] = [];
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA || resolve(homedir(), "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local");
    extraDirs.push(
      resolve(appData, "npm"),
      resolve(localAppData, "Microsoft", "WinGet", "Links"),
      resolve(localAppData, "Programs", "claude-code"),  // MSI installer
      resolve(homedir(), ".bun", "bin"),
      resolve(homedir(), "scoop", "shims"),              // scoop
    );
  } else {
    extraDirs.push(
      resolve(homedir(), ".bun", "bin"),
      resolve(homedir(), ".npm-global", "bin"),
      resolve(homedir(), ".local", "bin"),
      "/usr/local/bin",
    );
  }

  const allDirs = [...pathDirs, ...extraDirs];
  for (const dir of allDirs) {
    for (const ext of extensions) {
      const candidate = resolve(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Load configured endpoints from global config, with auto-detected CLIs as fallback. */
export function loadEndpoints(): Record<string, EndpointConfig> {
  const configFile = resolve(homedir(), ".snoot", "config.json");
  let endpoints: Record<string, EndpointConfig> = {};
  try {
    const config = JSON.parse(readFileSync(configFile, "utf-8"));
    endpoints = config.endpoints || {};
  } catch {}
  // Auto-register detected CLIs if not explicitly configured
  if (!endpoints.claude && findCliPath("claude")) {
    endpoints.claude = { type: "cli", cli: "claude" };
  }
  if (!endpoints.gemini && findCliPath("gemini")) {
    endpoints.gemini = { type: "cli", cli: "gemini" };
  }
  if (!endpoints.codex && findCliPath("codex")) {
    endpoints.codex = { type: "cli", cli: "codex" };
  }
  return endpoints;
}

/** Save an endpoint to global config */
export function saveEndpoint(name: string, ep: EndpointConfig): void {
  const configFile = resolve(GLOBAL_SNOOT_DIR, "config.json");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(configFile, "utf-8")); } catch {}
  if (!config.endpoints) config.endpoints = {};
  (config.endpoints as Record<string, EndpointConfig>)[name] = ep;
  mkdirSync(GLOBAL_SNOOT_DIR, { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  try { chmodSync(configFile, 0o600); } catch {}
}

/** Remove an endpoint from global config. Returns true if it existed. */
export function removeEndpoint(name: string): boolean {
  const configFile = resolve(GLOBAL_SNOOT_DIR, "config.json");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(configFile, "utf-8")); } catch {}
  const endpoints = config.endpoints as Record<string, EndpointConfig> | undefined;
  if (!endpoints?.[name]) return false;
  delete endpoints[name];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  try { chmodSync(configFile, 0o600); } catch {}
  return true;
}

/** Get display name for an endpoint */
export function endpointDisplayName(backend: string): string {
  if (backend === "gemini") return "Gemini";
  if (backend === "claude") return "Claude";
  if (backend === "codex") return "Codex";
  return backend.charAt(0).toUpperCase() + backend.slice(1);
}
