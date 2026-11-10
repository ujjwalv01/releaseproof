---
"releaseproof": patch
---

A publish attestation signed with a registry key that npm has since rotated is no longer reported as invalid. Key expiry is now checked against the time the transparency log recorded the signature (covered by Rekor's signed entry timestamp), as `npm audit signatures` does, so packages published with provenance before January 2025 no longer get a false `publish-attestation-invalid` and DIFFERS FROM SOURCE.
