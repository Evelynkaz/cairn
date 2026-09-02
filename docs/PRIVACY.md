# Privacy

This is a short summary. The authoritative description is
[BUILD_BRIEF.md §10 "Privacy / Security"](BUILD_BRIEF.md#10-privacy--security).

Cairn is offline by default: no telemetry, no cloud calls in the default
path, and nothing leaves the machine unless you explicitly export it.
Secret and PII detection runs at ingest, before anything is stored. Deletion
is first-class and complete, with an undo window, and "delete everything" is
always available. The database is a single file you can copy, back up, or
(in a future version) encrypt.

See the build brief for the full privacy and security design, including what
is deferred to later versions (e.g. at-rest encryption via SQLCipher).
