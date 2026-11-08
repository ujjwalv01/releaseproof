---
"releaseproof": patch
---

Reject registry signing key lists whose expiry is not a valid date string (an unparseable string, a number, a boolean, an object or an array) instead of treating the malformed key as non-expiring. Only an absent or null expiry means the key does not expire.
