export interface RerankItem {
  id: string;
  relevance: number;
  createdAt: number;
  importance: number;
  lastAccessed: number | null;
  accessCount: number;
}

export interface RerankWeights {
  relevance: number;
  recency: number;
  importance: number;
  access: number;
  halfLifeMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Starting-point weights for the generative-agents blend (BUILD_BRIEF §7),
 * NOT a tuned result — §14 warns against presenting self-run benchmark
 * numbers as fact, and these will need tuning against real transcripts
 * before they mean anything.
 */
export const DEFAULT_WEIGHTS: RerankWeights = {
  relevance: 0.5,
  recency: 0.25,
  importance: 0.15,
  access: 0.1,
  halfLifeMs: 7 * DAY_MS,
};

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function decay(elapsedMs: number, halfLifeMs: number): number {
  // Clamp negative elapsed time (clock skew / future timestamp) so decay
  // never exceeds 1 rather than growing unbounded.
  return 0.5 ** (Math.max(0, elapsedMs) / halfLifeMs);
}

/**
 * Saturating access boost in [0, 1). `accessCount / (accessCount + 5)`
 * alone already saturates toward 1, but it ignores WHEN the memory was
 * last touched — a memory read 1000 times a year ago would score the same
 * as one read 1000 times an hour ago. Blending in a recency-of-access term
 * (same half-life decay as `recency`, applied to `lastAccessed` instead of
 * `createdAt`) makes a stale-but-once-popular memory fade. The result is
 * capped well below 1 and paired with a small default `access` weight so
 * that no amount of access count can bury a memory that is simply more
 * relevant — a memory read 1000 times cannot outrank a clearly relevant
 * result on access count alone.
 */
function accessBoost(accessCount: number, lastAccessed: number | null, now: number, halfLifeMs: number): number {
  const count = Math.max(0, accessCount);
  const countTerm = count / (count + 5);
  const recencyTerm = lastAccessed === null ? 0 : decay(now - lastAccessed, halfLifeMs);
  return countTerm * recencyTerm;
}

/**
 * The generative-agents-style blend from BUILD_BRIEF §7:
 * `score = w.relevance*relevance + w.recency*recency(exp decay) +
 * w.importance*importance + w.access*access(saturating)`.
 *
 * `now` is a parameter — never `Date.now()` internally — so the function
 * is deterministic and exactly testable. `relevance`/`importance` are
 * expected in 0..1 and are clamped defensively rather than trusted.
 * Returns the per-component `parts` alongside `score` because an
 * untunable blend with no breakdown is useless once real transcripts show
 * it needs adjusting.
 */
export function rerank<T extends RerankItem>(
  items: readonly T[],
  now: number,
  weights: Partial<RerankWeights> = {},
): (T & { score: number; parts: { relevance: number; recency: number; importance: number; access: number } })[] {
  const w: RerankWeights = { ...DEFAULT_WEIGHTS, ...weights };

  return items.map((item) => {
    const relevance = clamp01(item.relevance);
    const importance = clamp01(item.importance);
    const recency = decay(now - item.createdAt, w.halfLifeMs);
    const access = accessBoost(item.accessCount, item.lastAccessed, now, w.halfLifeMs);

    const parts = {
      relevance: w.relevance * relevance,
      recency: w.recency * recency,
      importance: w.importance * importance,
      access: w.access * access,
    };

    return {
      ...item,
      score: parts.relevance + parts.recency + parts.importance + parts.access,
      parts,
    };
  });
}
