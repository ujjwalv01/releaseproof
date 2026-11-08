---
"releaseproof": patch
---

Clarify that `--offline` only makes Sigstore prefer its cached trust root, which is still
fetched when the cache is missing or expired; registry, source, image, dependency and
staged Rekor requests can still use the network.
