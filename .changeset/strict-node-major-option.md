---
"releaseproof": patch
---

Strictly validate `--node` and the Action's `node` input with shared `parseNodeMajorOption` to reject non-decimal literals such as `0x16`, `1e1` and `22.0`.
