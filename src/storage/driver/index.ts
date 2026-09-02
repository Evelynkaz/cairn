export type {
  DriverFactory,
  OpenOptions,
  PreparedStatement,
  Row,
  RunResult,
  SqliteDriver,
  SqlValue,
} from "./types.js";
import { openNodeSqlite } from "./node-sqlite.js";
import type { DriverFactory } from "./types.js";

// This is the only place the concrete driver is chosen; swapping it is the
// whole point of the seam.
export const defaultDriver: DriverFactory = openNodeSqlite;
