---
"releaseproof": patch
---

`releaseproof check` now rejects a malformed `--repo` (such as `github.com/o/r` without a
scheme, or plain `nope`) with a clear tool error before it fetches anything. Previously the
unreadable expectation was compared against the certified repository and produced a false
`provenance-repository-unexpected` critical finding, plus a Rekor lookup that matched no
entries. `https://github.com/o/r`, `o/r` and `git+https://github.com/o/r.git` keep working.
