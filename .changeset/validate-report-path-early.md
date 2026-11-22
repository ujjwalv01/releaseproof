---
"releaseproof": patch
---

Validate `--report` parent directory and target path writability before running the check so unwritable paths fail immediately instead of after a rebuild.
