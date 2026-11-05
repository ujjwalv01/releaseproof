---
"releaseproof": patch
---

Validate and normalize --memory before starting a check, using the same Docker-size
parser as the Action, and report invalid values as immediate tool errors.
