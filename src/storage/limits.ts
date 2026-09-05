// The input caps shared by every write path (BUILD_BRIEF §12): the HTTP
// boundary (src/dashboard/api.ts) and the store itself (src/storage/store.ts)
// both enforce these, independently, because the MCP path goes straight past
// the HTTP boundary and only the store sits on every write path (HTTP, every
// MCP tool, and both import methods). Two enforcement sites are needed; one
// set of numbers is not, so both layers import the constants from here
// rather than restating them -- a different number in each place would be
// worse than either number alone. Each layer keeps its own enforcement
// style (api.ts answers 400 at the HTTP boundary; store.ts throws for every
// caller, including MCP tools that never touch api.ts).
//
// A pasted import's `tags` array is re-applied to EVERY entry parsed out of
// `text`, so N entries x unbounded tags becomes unbounded rows -- measured
// at 500 entries x 2000 tags = 1,000,000 tag rows from a single ~25 KB
// request, blocking the single-threaded daemon for minutes. A cap is
// refused with an error rather than silently truncated, so a paste that
// looks like it worked never silently drops the user's own tags.
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 64;
export const MAX_SCOPE_LENGTH = 128;

// Nothing anywhere bounded a memory's own TEXT length: a 4 MB memory made
// list_memories's default page return 7.8 MB, and a 20 MB one crashed the
// ingest path with a raw V8 "Maximum call stack size exceeded" out of the
// redaction regex, surfaced straight to the client, and a persistent one:
// every later list/recall pays for one oversized write forever, which is
// exactly the "bound every tool's output" rule (BUILD_BRIEF §12) this
// violates. 64 KiB is chosen as comfortably larger than any real note,
// transcript excerpt or pasted snippet this product's memories are for
// (§1: not document storage), while keeping the redaction regex pass, the
// FTS index and every paginated read far away from the input sizes that
// produced the measured crash.
export const MAX_CONTENT_LENGTH = 65536;
