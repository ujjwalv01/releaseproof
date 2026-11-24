---
"releaseproof": patch
---

Require a `k`, `m` or `g` unit and at least 6 MiB (Docker's minimum) for `--memory` and the Action's `memory` input so `0` or unitless byte counts cannot disable or break container memory limits.
