import { resolve, delimiter as PATH_DELIMITER } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import type { EndpointConfig } from "./types.js";

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
  return endpoints;
}

/** Get display name for an endpoint */
export function endpointDisplayName(backend: string): string {
  if (backend === "gemini") return "Gemini";
  if (backend === "claude") return "Claude";
  return backend.charAt(0).toUpperCase() + backend.slice(1);
}
