---
"releaseproof": patch
---

The Action now sets the `verdict`, `exit-code` and `summary` outputs, writes a job summary
and opens its issue (when `create-issue` is enabled) even when the check itself fails with
a tool error such as an unreachable registry or a missing Docker daemon. Previously those
runs only called `setFailed` and left the outputs empty.
