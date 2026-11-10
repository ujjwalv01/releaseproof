import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SIGSTORE_5, sigstoreAttestations, withEditedProvenance } from "../../test/fixtures.js";
import { fetchPublished } from "../fetch/published.js";
import { fetchRegistryKeys } from "./keys.js";
import { verifyProvenance } from "./verify.js";

/**
 * Real Sigstore verification. Needs the network (Sigstore TUF root, npm registry).
 * Opt in with RELEASEPROOF_NET_TESTS=1.
 */
describe.skipIf(!process.env.RELEASEPROOF_NET_TESTS)("verifyProvenance (network)", () => {
  const tufCachePath = mkdtempSync(path.join(tmpdir(), "releaseproof-tuf-"));
  const input = {
    purl: SIGSTORE_5.purl,
    sha512Hex: SIGSTORE_5.sha512Hex,
    attestations: sigstoreAttestations(),
  };

  it("verifies the real sigstore@5.0.0 bundles with sigstore-js", async () => {
    const registryKeys = await fetchRegistryKeys();
    const result = await verifyProvenance(input, { registryKeys, tufCachePath });
    expect(result.problems).toEqual([]);
    expect(result.status).toBe("verified");
    expect(result.source?.commit).toBe(SIGSTORE_5.commit);
    expect(result.publishAttestation.status).toBe("verified");
  }, 60_000);

  it("rejects a provenance whose payload was edited after signing", async () => {
    const forged = withEditedProvenance(input.attestations, (statement) => {
      const p = statement.predicate as {
        buildDefinition: { resolvedDependencies: { digest: { gitCommit: string } }[] };
      };
      for (const dependency of p.buildDefinition.resolvedDependencies) {
        dependency.digest.gitCommit = "0".repeat(40);
      }
    });
    const result = await verifyProvenance(
      { ...input, attestations: forged },
      { tufCachePath, offline: true },
    );
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toMatch(/signature verification failed/);
  }, 60_000);

  it("accepts a publish attestation signed before npm rotated its key (sigstore@2.0.0)", async () => {
    // Logged on 2023-08-18 with SHA256:jl3b…, which the registry lists as expired on 2025-01-29.
    const artifact = await fetchPublished("sigstore@2.0.0");
    const registryKeys = await fetchRegistryKeys();
    const result = await verifyProvenance(
      {
        purl: artifact.purl,
        sha512Hex: artifact.digests.sha512Hex,
        attestations: artifact.attestations,
      },
      { registryKeys, tufCachePath },
    );
    expect(result.publishAttestation).toEqual({
      status: "verified",
      keyid: "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
    });
  }, 60_000);

  it("fetches the real package and its attestations", async () => {
    const artifact = await fetchPublished("sigstore@5.0.0");
    expect(artifact.digests.sha512Hex).toBe(SIGSTORE_5.sha512Hex);
    expect(artifact.attestations?.attestations.map((a) => a.predicateType)).toContain(
      "https://slsa.dev/provenance/v1",
    );
    expect(artifact.hints.gitHead).toBe(SIGSTORE_5.commit);
  }, 60_000);
});
