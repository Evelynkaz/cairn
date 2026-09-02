// Domain types mirroring the schema in migrations/001-init.ts. Timestamps
// are epoch milliseconds. Types use camelCase; the SQL columns are
// snake_case — the mapping happens in the repositories (next round).

export type Scope = string;
export type MemoryId = string;
export type EpisodeId = string;

export const DEFAULT_SCOPE = "default";

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
}

export interface ClientRecord {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  enabled: boolean;
}

export interface VectorSpace {
  id: number;
  modelId: string;
  dim: number;
  tableName: string;
  createdAt: number;
}
