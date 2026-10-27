import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASEPROOF_011 } from "../../test/fixtures.js";
import { findRekorAttestations, findRekorProvenance } from "./rekor.js";

/**
 * The real Rekor lookup for releaseproof@0.1.1, whose provenance npm wrote to the log when
 * the version was staged. Needs the network (Rekor, Sigstore TUF root).
 * Opt in with RELEASEPROOF_NET_TESTS=1.
 */
describe.skipIf(!process.env.RELEASEPROOF_NET_TESTS)("findRekorProvenance (network)", () => {
  const tufCachePath = mkdtempSync(path.join(tmpdir(), "releaseproof-tuf-"));
  const subject = { purl: RELEASEPROOF_011.purl, sha512Hex: RELEASEPROOF_011.sha512Hex };

  it("finds the provenance entry by the tarball's SHA-512", async () => {
    const found = await findRekorAttestations(subject);
    expect(found.attestations.map((a) => a.logIndex)).toContain(RELEASEPROOF_011.logIndex);
  }, 60_000);

  it("verifies it with sigstore-js and certifies the source", async () => {
    const result = await findRekorProvenance(subject, {
      expectedRepository: RELEASEPROOF_011.repository,
      tufCachePath,
    });
    expect(result.notes).toEqual([]);
    expect(result.provenance).toMatchObject({
      status: "verified",
      attestationSource: "rekor",
      problems: [],
      mismatches: [],
      source: { repository: RELEASEPROOF_011.repository, commit: RELEASEPROOF_011.commit },
    });
  }, 60_000);
});
