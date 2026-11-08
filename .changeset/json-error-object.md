---
"releaseproof": patch
---

Print one `{"error":{"message":…}}` object to stdout when `check --json` ends in a tool error, so scripts piping stdout can see what went wrong instead of an empty stream.
