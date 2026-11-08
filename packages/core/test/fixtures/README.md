# Captured provenance fixtures

These JSON files keep provenance tests offline. [../fixtures.ts](../fixtures.ts) provides
the readers and constants used by the tests. Capture dates and original capture commands
are not recorded here; the sources and transformations below describe the checked-in
data, not a guarantee that today's responses will be byte-for-byte identical.

## `sigstore-5.0.0/`

| File | Source and representation | Reader in `fixtures.ts` |
| --- | --- | --- |
| `attestations.json` | [npm attestations for sigstore@5.0.0](https://registry.npmjs.org/-/npm/v1/attestations/sigstore@5.0.0): the publish and SLSA provenance bundles. | `sigstoreAttestations()` |
| `keys.json` | [npm registry signing keys](https://registry.npmjs.org/-/npm/v1/keys): the response's `keys` array includes the key referenced by the publish bundle. | `sigstoreKeys()` returns the `keys` array. |
| `manifest.json` | [sigstore@5.0.0 version metadata](https://registry.npmjs.org/sigstore/5.0.0), including `dist`, `gitHead` and `repository`. | No dedicated helper or current direct consumer; `readFixtureJson("sigstore-5.0.0", "manifest.json")` can read it. |
| `signer-identity.json` | Derived from the provenance bundle in the attestations response above: its `_note` records the `Signer.identity` returned by `sigstore@5.0.0`'s `verify()`. This is not another registry response. | `sigstoreSignerIdentity()` |

The identity is stored as JSON: each OID has a dotted `id` and `valueBase64` containing
the raw extension bytes. The helper converts these back to numeric OID arrays and
`Buffer`s, preserving the subject alternative name and issuer extension. The `_note`
is explanatory metadata. Other manual edits to these captures are not recorded.

## `releaseproof-0.1.1/`

| File | Source and representation | Reader in `fixtures.ts` |
| --- | --- | --- |
| `attestations.json` | [npm attestations for releaseproof@0.1.1](https://registry.npmjs.org/-/npm/v1/attestations/releaseproof@0.1.1): the publish and SLSA provenance bundles. | `releaseproofAttestations()` |
| `rekor-entry.json` | Manually written from the provenance bundle's tlog entry in Rekor's API shape, equivalent to [GET /api/v1/log/entries/{uuid}](https://rekor.sigstore.dev/api/v1/log/entries/108e9186e8c5677a111b04dc48ca27af608ba149d59a4d58e23e5f054206bd18c5168a126dfa727f), rather than a recorded direct download of that URL. | `releaseproofRekorEntry()` |

The helper comment records that the provenance was logged at stage time, then served by
npm after approval. Select its tlog entry at **logIndex `3310501741`**; the publish bundle
has a different entry. Other manual edits to the attestations capture are not recorded.

To reconstruct `rekor-entry.json`, reverse the conversion in
[`bundleFromRekorEntry()`](../../src/provenance/rekor.ts):

| Bundle tlog field | Rekor API entry field |
| --- | --- |
| `canonicalizedBody` | `body`, unchanged base64 text |
| `logId.keyId` | `logID`, decoded from base64 and encoded as hex |
| `logIndex`, `integratedTime` | Same names, converted from decimal strings to numbers |
| `inclusionPromise.signedEntryTimestamp` | `verification.signedEntryTimestamp`, unchanged |
| `inclusionProof.logIndex`, `treeSize` | `verification.inclusionProof` numeric fields |
| `inclusionProof.rootHash`, `hashes` | `verification.inclusionProof` hex values decoded from base64 |
| `inclusionProof.checkpoint.envelope` | `verification.inclusionProof.checkpoint`, unchanged string |

The response object is keyed by the entry UUID: the 16-character hex tree id followed by
the 64-character leaf hash. For this capture, the checkpoint's first line names tree id
`1193050959916656506` (`108e9186e8c5677a` in hex); append
`SHA256(0x00 || base64Decode(canonicalizedBody))` to obtain
`108e9186e8c5677a111b04dc48ca27af608ba149d59a4d58e23e5f054206bd18c5168a126dfa727f`.
The inclusion proof's leaf index (`3188597479`) differs from the entry's `logIndex`;
copy each from its own field. Keep the signed body, timestamp and checkpoint unchanged.
The existing `rekor.test.ts` checks that converting this entry back yields the stored
provenance bundle.

## Adding a fixture for another package

1. Choose an explicit package/version and create its folder. Capture its npm version
   document, attestations response and any required registry keys using the URL patterns
   above. Record the exact URLs, capture date, commands and any edits in this README.
2. Record the purl, actual tarball digest, repository and commit in `fixtures.ts` constants;
   cross-check the manifest and signed statement rather than guessing them.
3. If identity tests need it, verify the provenance bundle with sigstore and serialize
   the returned identity in the format above; do not invent certificate extensions.
4. If Rekor tests need it, select the provenance tlog entry and reconstruct the API shape
   using the mapping above. Record its log index and UUID, and check the round trip.
5. Add readers in `fixtures.ts` and tests that use the stored data. For deliberately
   invalid cases, mutate copies with `withEditedProvenance()` or `withFulcioOid()` rather
   than overwriting the captured valid fixture. Run `pnpm check` and `pnpm build`; the
   offline suite must not need fresh registry or Rekor responses.
