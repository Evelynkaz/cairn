// Barrel for the daemon module: the process that owns the database and
// serves MCP over Streamable HTTP (BUILD_BRIEF §4), plus the runtime-file
// helpers a client uses to find it.

export { startDaemon } from "./server.js";
export type { DaemonOptions, DaemonHandle } from "./server.js";

export { readRuntimeFile, writeRuntimeFile, removeRuntimeFile, isDaemonAlive, generateToken, runtimeFilePath } from "./runtime-file.js";
export type { RuntimeInfo } from "./runtime-file.js";
