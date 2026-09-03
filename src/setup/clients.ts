import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type ClientId = "claude-desktop" | "claude-code" | "cursor";

export interface ClientTarget {
  id: ClientId;
  name: string;
  configPath: string;
  transport: "stdio" | "http";
  detected: boolean;
}

function claudeDesktopConfigPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function detected(configPath: string): boolean {
  return existsSync(configPath) || existsSync(dirname(configPath));
}

// Claude Code's config path is `~/.claude.json`, so the generic
// parent-directory check above (`dirname` of that path) is the home
// directory itself -- which exists on every machine, detected or not. Use
// the config file or a `~/.claude` directory as the real signal instead.
function claudeCodeDetected(configPath: string, home: string): boolean {
  return existsSync(configPath) || existsSync(join(home, ".claude"));
}

export function clientTargets(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = process.env.HOME ?? process.env.USERPROFILE ?? "",
): ClientTarget[] {
  const claudeDesktopPath = claudeDesktopConfigPath(env, platform, home);
  const claudeCodePath = join(home, ".claude.json");
  const cursorPath = join(home, ".cursor", "mcp.json");

  return [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      configPath: claudeDesktopPath,
      transport: "stdio",
      detected: detected(claudeDesktopPath),
    },
    {
      id: "claude-code",
      name: "Claude Code",
      configPath: claudeCodePath,
      transport: "stdio",
      detected: claudeCodeDetected(claudeCodePath, home),
    },
    {
      id: "cursor",
      name: "Cursor",
      configPath: cursorPath,
      transport: "stdio",
      detected: detected(cursorPath),
    },
  ];
}
