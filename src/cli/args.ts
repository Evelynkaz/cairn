// Pure argument parsing for the `cairn` CLI (BUILD_BRIEF §11, §16.5). No
// I/O, no process.exit, no printing here -- that is what makes this module
// (and the commands it feeds) testable without a real process, and it is
// what commands.ts and index.ts rely on. See index.ts for how a bare
// `cairn` invocation (no subcommand) is dispatched differently depending on
// whether stdin is a TTY -- that decision needs real process state, so it
// deliberately does not live here; this module only ever returns the
// "root" command and lets the caller decide what it means.

export type ParsedCommand =
  | { command: "root" }
  | { command: "help" }
  | { command: "version" }
  | { command: "mcp" }
  | { command: "daemon" }
  | { command: "status"; json: boolean }
  | { command: "start" }
  | { command: "stop" }
  | { command: "ui"; open: boolean }
  | { command: "setup"; clients: string[]; dryRun: boolean; print: boolean }
  | { command: "embeddings-status"; json: boolean }
  | { command: "embeddings-enable"; provider?: string; modelId?: string }
  | { command: "embeddings-disable" }
  | { command: "hook-session-start" }
  | { command: "error"; message: string };

export const TOP_LEVEL_COMMANDS = [
  "mcp",
  "daemon",
  "status",
  "start",
  "stop",
  "ui",
  "setup",
  "embeddings",
  "hook",
  "help",
] as const;

const EMBEDDINGS_SUBCOMMANDS = ["status", "enable", "disable"] as const;
const HOOK_SUBCOMMANDS = ["session-start"] as const;

type FlagKind = "boolean" | "value" | "repeatable";
type FlagSpec = Record<string, FlagKind>;

function splitFlag(token: string): { key: string; value: string | undefined } {
  const eq = token.indexOf("=");
  if (eq === -1) {
    return { key: token, value: undefined };
  }
  return { key: token.slice(0, eq), value: token.slice(eq + 1) };
}

function validFlagsList(spec: FlagSpec): string {
  const keys = Object.keys(spec);
  return keys.length > 0 ? keys.join(", ") : "(none)";
}

// Parses a flat list of `--flag`/`--key=value` tokens against `spec`,
// returning either the parsed flags or an error naming the offending token
// and listing the flags `commandLabel` actually accepts -- a CLI that only
// says "unknown option" makes the user go hunting.
function parseFlags(
  tokens: string[],
  spec: FlagSpec,
  commandLabel: string,
): { flags: Record<string, string | string[] | boolean>; error?: string } {
  const flags: Record<string, string | string[] | boolean> = {};
  for (const token of tokens) {
    if (!token.startsWith("--")) {
      return {
        flags,
        error: `unexpected argument "${token}" for "cairn ${commandLabel}"; valid flags are: ${validFlagsList(spec)}`,
      };
    }
    const { key, value } = splitFlag(token);
    const kind = spec[key];
    if (!kind) {
      return {
        flags,
        error: `unknown flag "${key}" for "cairn ${commandLabel}"; valid flags are: ${validFlagsList(spec)}`,
      };
    }
    if (kind === "boolean") {
      if (value !== undefined) {
        return { flags, error: `flag "${key}" for "cairn ${commandLabel}" takes no value` };
      }
      flags[key] = true;
    } else if (value === undefined) {
      return { flags, error: `flag "${key}" for "cairn ${commandLabel}" requires a value, e.g. "${key}=..."` };
    } else if (kind === "value") {
      flags[key] = value;
    } else {
      const existing = flags[key];
      flags[key] = Array.isArray(existing) ? [...existing, value] : [value];
    }
  }
  return { flags };
}

function parseStatus(tokens: string[]): ParsedCommand {
  const { flags, error } = parseFlags(tokens, { "--json": "boolean" }, "status");
  if (error) {
    return { command: "error", message: error };
  }
  return { command: "status", json: flags["--json"] === true };
}

function parseUi(tokens: string[]): ParsedCommand {
  const { flags, error } = parseFlags(tokens, { "--no-open": "boolean" }, "ui");
  if (error) {
    return { command: "error", message: error };
  }
  return { command: "ui", open: flags["--no-open"] !== true };
}

function parseSetup(tokens: string[]): ParsedCommand {
  const { flags, error } = parseFlags(
    tokens,
    { "--client": "repeatable", "--dry-run": "boolean", "--print": "boolean" },
    "setup",
  );
  if (error) {
    return { command: "error", message: error };
  }
  const clientValue = flags["--client"];
  const clients = Array.isArray(clientValue) ? clientValue : clientValue !== undefined ? [String(clientValue)] : [];
  return {
    command: "setup",
    clients,
    dryRun: flags["--dry-run"] === true,
    print: flags["--print"] === true,
  };
}

function parseEmbeddings(tokens: string[]): ParsedCommand {
  const [sub, ...rest] = tokens;
  if (sub === undefined || !(EMBEDDINGS_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return {
      command: "error",
      message: `unknown "cairn embeddings" subcommand "${sub ?? ""}"; valid subcommands are: ${EMBEDDINGS_SUBCOMMANDS.join(", ")}`,
    };
  }
  if (sub === "status") {
    const { flags, error } = parseFlags(rest, { "--json": "boolean" }, "embeddings status");
    if (error) {
      return { command: "error", message: error };
    }
    return { command: "embeddings-status", json: flags["--json"] === true };
  }
  if (sub === "enable") {
    const { flags, error } = parseFlags(
      rest,
      { "--provider": "value", "--model": "value" },
      "embeddings enable",
    );
    if (error) {
      return { command: "error", message: error };
    }
    return {
      command: "embeddings-enable",
      provider: typeof flags["--provider"] === "string" ? (flags["--provider"] as string) : undefined,
      modelId: typeof flags["--model"] === "string" ? (flags["--model"] as string) : undefined,
    };
  }
  const { error } = parseFlags(rest, {}, "embeddings disable");
  if (error) {
    return { command: "error", message: error };
  }
  return { command: "embeddings-disable" };
}

function parseHook(tokens: string[]): ParsedCommand {
  const [sub, ...rest] = tokens;
  if (sub === undefined || !(HOOK_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return {
      command: "error",
      message: `unknown "cairn hook" subcommand "${sub ?? ""}"; valid subcommands are: ${HOOK_SUBCOMMANDS.join(", ")}`,
    };
  }
  const { error } = parseFlags(rest, {}, "hook session-start");
  if (error) {
    return { command: "error", message: error };
  }
  return { command: "hook-session-start" };
}

function parseNoFlags(tokens: string[], command: "mcp" | "daemon" | "start" | "stop"): ParsedCommand {
  const { error } = parseFlags(tokens, {}, command);
  if (error) {
    return { command: "error", message: error };
  }
  return { command };
}

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    return { command: "root" };
  }
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help" };
  }
  if (first === "--version") {
    return { command: "version" };
  }
  switch (first) {
    case "mcp":
    case "daemon":
    case "start":
    case "stop":
      return parseNoFlags(rest, first);
    case "status":
      return parseStatus(rest);
    case "ui":
      return parseUi(rest);
    case "setup":
      return parseSetup(rest);
    case "embeddings":
      return parseEmbeddings(rest);
    case "hook":
      return parseHook(rest);
    default:
      return {
        command: "error",
        message: `unknown command "${first}"; valid commands are: ${TOP_LEVEL_COMMANDS.join(", ")}`,
      };
  }
}
