// Domain types mirroring the schema in migrations/001-init.ts. Timestamps
// are epoch milliseconds. Types use camelCase; the SQL columns are
// snake_case — the mapping happens in the repositories (next round).

export type Scope = string;
export type MemoryId = string;
export type EpisodeId = string;

export const DEFAULT_SCOPE = "default";

// See migrations/004-provenance.ts for the full reasoning. 'user' is a
// direct remember/update/supersede from an MCP client or the dashboard;
// 'import' is anything that entered through importMemory/importEpisode or a
// vendor importer built on it; 'unknown' is a row that predates this
// column and carries no provenance record at all.
export type MemoryOrigin = "user" | "import" | "unknown";

export interface Episode {
  id: EpisodeId;
  content: string;
  scope: Scope;
  sourceClient: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface Memory {
  id: MemoryId;
  seq: number;
  text: string;
  scope: Scope;
  sourceClient: string | null;
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastAccessed: number | null;
  accessCount: number;
  validFrom: number;
  validUntil: number | null;
  supersededBy: MemoryId | null;
  episodeId: EpisodeId | null;
  deletedAt: number | null;
  redacted: boolean;
  contentHash: string;
  tags: string[];
  origin: MemoryOrigin;
  // Whether a human has vetted a non-'user' memory as trusted for automatic
  // SessionStart injection (see src/retrieval/context.ts). Meaningless for
  // 'user'-origin memories, which are already eligible regardless of this
  // flag.
  approved: boolean;
}

export interface AuditEvent {
  id: number;
  ts: number;
  action: string;
  memoryId: MemoryId | null;
  scope: Scope | null;
  sourceClient: string | null;
  query: string | null;
  resultCount: number | null;
  details: Record<string, unknown> | null;
  refused: boolean;
}

export interface ClientRecord {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  enabled: boolean;
}

export type RedactionAction = "redacted" | "blocked";

export interface RedactionRecord {
  id: number;
  ts: number;
  memoryId: MemoryId | null;
  episodeId: EpisodeId | null;
  scope: Scope | null;
  sourceClient: string | null;
  kind: string;
  preview: string;
  action: RedactionAction;
}
