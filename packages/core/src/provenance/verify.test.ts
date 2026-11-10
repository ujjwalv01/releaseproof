import { describe, expect, it, vi } from "vitest";
import {
  SIGSTORE_5,
  sigstoreAttestations,
  sigstoreKeys,
  sigstoreSignerIdentity,
  withEditedProvenance,
  withFulcioOid,
} from "../../test/fixtures.js";
import type { SignerIdentityLike } from "./certificate.js";
import { NPM_PUBLISH_ATTESTATION_V01, SLSA_PROVENANCE_V1 } from "./predicate.js";
import { type BundleVerifier, crossCheck, signedLogTime, verifyProvenance } from "./verify.js";

const input = {
  purl: SIGSTORE_5.purl,
  sha512Hex: SIGSTORE_5.sha512Hex,
  attestations: sigstoreAttestations(),
};

/** Pretends every signature is valid and reports the given identity for certificate bundles. */
function verifierReturning(identity: SignerIdentityLike | undefined = sigstoreSignerIdentity()) {
  return vi.fn<BundleVerifier>(async (bundle) => {
    const material = bundle.verificationMaterial as { certificate?: unknown };
    return material.certificate ? { identity } : {};
  });
}

describe("verifyProvenance", () => {
  it("verifies the real sigstore@5.0.0 attestations and reports the certified source", async () => {
    const verifier = verifierReturning();
    const result = await verifyProvenance(input, {
      verifier,
      registryKeys: sigstoreKeys(),
      offline: true,
      tufCachePath: "/cache",
    });

    expect(result.status).toBe("verified");
    expect(result.problems).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.signerOutsideRepository).toBeUndefined();
    expect(result.source).toEqual({
      repository: SIGSTORE_5.repository,
      commit: SIGSTORE_5.commit,
      ref: "refs/heads/main",
      workflowPath: ".github/workflows/release.yml",
      workflowRef: "refs/heads/main",
      trigger: "push",
      runnerEnvironment: "github-hosted",
      invocationUri: "https://github.com/sigstore/sigstore-js/actions/runs/26781866618/attempts/1",
      visibility: "public",
      repositoryId: "495574555",
      ownerUri: "https://github.com/sigstore",
    });
    expect(result.predicate?.commit).toBe(SIGSTORE_5.commit);
    expect(result.transparencyLog).toEqual({
      logIndex: "1697019812",
      integratedTime: "1780347770",
    });
    expect(result.publishAttestation).toEqual({ status: "verified", keyid: SIGSTORE_5.keyid });

    // Both bundles were verified; the publish one with the registry key, offline as requested.
    expect(verifier).toHaveBeenCalledTimes(2);
    const publishCall = verifier.mock.calls.find(([bundle]) =>
      bundle.mediaType.includes("version=0.2"),
    );
    expect(publishCall?.[1].keySelector?.(SIGSTORE_5.keyid)).toMatch(/BEGIN PUBLIC KEY/);
    expect(publishCall?.[1].keySelector?.("SHA256:other")).toBeUndefined();
    expect(publishCall?.[1]).toMatchObject({ tufForceCache: true, tufCachePath: "/cache" });
  });

  it("reports missing when the registry has no attestations", async () => {
    for (const attestations of [null, { attestations: [] }]) {
      const result = await verifyProvenance(
        { ...input, attestations },
        { verifier: verifierReturning() },
      );
      expect(result.status).toBe("missing");
      expect(result.publishAttestation.status).toBe("missing");
      expect(result.source).toBeUndefined();
      expect(result.problems).toEqual(["the registry has no attestations for this version"]);
    }
  });

  it("reports missing provenance when only a publish attestation exists", async () => {
    const onlyPublish = {
      attestations: input.attestations.attestations.filter(
        (a) => a.predicateType === NPM_PUBLISH_ATTESTATION_V01,
      ),
    };
    const result = await verifyProvenance(
      { ...input, attestations: onlyPublish },
      { verifier: verifierReturning(), registryKeys: sigstoreKeys() },
    );
    expect(result.status).toBe("missing");
    expect(result.publishAttestation.status).toBe("verified");
  });

  it("is invalid when the subject digest does not match the downloaded tarball", async () => {
    const verifier = verifierReturning();
    const result = await verifyProvenance(
      { ...input, sha512Hex: "00".repeat(64) },
      { verifier, registryKeys: sigstoreKeys() },
    );
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toMatch(
      /provenance subject sha512 digest .* does not match the tarball/,
    );
    expect(result.publishAttestation).toMatchObject({
      status: "invalid",
      problem: expect.stringMatching(/does not match/),
    });
    expect(result.source).toBeUndefined();
    // Nothing is sent to the verifier when the subject is already wrong.
    expect(verifier).not.toHaveBeenCalled();
  });

  it("is invalid when the subject names another package", async () => {
    const result = await verifyProvenance(
      { ...input, purl: "pkg:npm/sigstore@5.0.1" },
      { verifier: verifierReturning() },
    );
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toMatch(
      /subject is pkg:npm\/sigstore@5.0.0, not pkg:npm\/sigstore@5.0.1/,
    );
  });

  it("is invalid when the signature does not verify", async () => {
    const verifier = vi.fn<BundleVerifier>(async () => {
      throw new Error("DSSE payload hash mismatch");
    });
    const result = await verifyProvenance(input, { verifier, registryKeys: sigstoreKeys() });
    expect(result.status).toBe("invalid");
    expect(result.problems).toEqual([
      "provenance signature verification failed: DSSE payload hash mismatch",
    ]);
    expect(result.source).toBeUndefined();
    expect(result.publishAttestation.problem).toMatch(/signature verification failed/);
  });

  it("reports every field where the job's claim disagrees with the certificate", async () => {
    const forged = withEditedProvenance(input.attestations, (statement) => {
      const p = statement.predicate as {
        buildDefinition: {
          resolvedDependencies: { digest: { gitCommit: string } }[];
          externalParameters: { workflow: { path: string } };
        };
      };
      for (const dependency of p.buildDefinition.resolvedDependencies) {
        dependency.digest.gitCommit = "0".repeat(40);
      }
      p.buildDefinition.externalParameters.workflow.path = ".github/workflows/evil.yml";
    });
    const result = await verifyProvenance(
      { ...input, attestations: forged },
      { verifier: verifierReturning() },
    );
    expect(result.status).toBe("verified");
    expect(result.source?.commit).toBe(SIGSTORE_5.commit);
    expect(result.mismatches).toEqual([
      { field: "commit", certificate: SIGSTORE_5.commit, predicate: "0".repeat(40) },
      {
        field: "workflow",
        certificate: SIGSTORE_5.workflow,
        predicate:
          "https://github.com/sigstore/sigstore-js/.github/workflows/evil.yml@refs/heads/main",
      },
    ]);
  });

  it("reports a signer outside the source repository (reusable workflow)", async () => {
    const signer =
      "https://github.com/sxzz/workflows/.github/workflows/release.yml@refs/heads/main";
    const identity = withFulcioOid(
      { ...sigstoreSignerIdentity(), subjectAlternativeName: signer },
      9,
      signer,
    );
    const result = await verifyProvenance(input, { verifier: verifierReturning(identity) });
    expect(result.status).toBe("verified");
    expect(result.signerOutsideRepository).toBe(signer);
    expect(result.mismatches).toEqual([]);
  });

  it("is unsupported when the certificate issuer is not GitHub Actions", async () => {
    const identity = withFulcioOid(
      { ...sigstoreSignerIdentity(), extensions: { issuer: "https://gitlab.com" } },
      8,
      "https://gitlab.com",
    );
    const result = await verifyProvenance(input, { verifier: verifierReturning(identity) });
    expect(result.status).toBe("unsupported");
    expect(result.problems).toEqual([
      "provenance certificate issuer https://gitlab.com is not GitHub Actions",
    ]);
    expect(result.source).toBeUndefined();
  });

  it("is unsupported for a non-GitHub build type without calling the verifier", async () => {
    const other = withEditedProvenance(input.attestations, (statement) => {
      (
        statement.predicate as { buildDefinition: { buildType: string } }
      ).buildDefinition.buildType = "https://example.com/x";
    });
    const verifier = verifierReturning();
    const result = await verifyProvenance({ ...input, attestations: other }, { verifier });
    expect(result.status).toBe("unsupported");
    expect(verifier).not.toHaveBeenCalled();
  });

  it("is invalid when the certificate lacks the source commit", async () => {
    const identity = {
      ...sigstoreSignerIdentity(),
      oids: sigstoreSignerIdentity().oids?.filter((entry) => entry.oid?.id?.at(-1) !== 13),
    };
    const result = await verifyProvenance(input, { verifier: verifierReturning(identity) });
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toMatch(/certificate lacks/);
  });

  it("is invalid when the registry lists a different predicate type than the signed statement", async () => {
    const relabelled = structuredClone(input.attestations);
    for (const entry of relabelled.attestations) {
      if (entry.predicateType === SLSA_PROVENANCE_V1) {
        entry.predicateType = "https://slsa.dev/provenance/v1.1";
      }
    }
    const result = await verifyProvenance(
      { ...input, attestations: relabelled },
      { verifier: verifierReturning() },
    );
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toMatch(
      /registry lists predicate type .* but the signed statement says/,
    );
  });

  it("is invalid with more than one provenance attestation", async () => {
    const doubled = {
      attestations: [...input.attestations.attestations, ...input.attestations.attestations],
    };
    const result = await verifyProvenance(
      { ...input, attestations: doubled },
      { verifier: verifierReturning() },
    );
    expect(result.status).toBe("invalid");
    expect(result.problems).toEqual(["expected one provenance attestation, found 2"]);
  });

  it("warns about unknown attestation types without failing", async () => {
    const extra = {
      attestations: [
        ...input.attestations.attestations,
        { predicateType: "https://example.com/custom", bundle: {} },
      ],
    };
    const result = await verifyProvenance(
      { ...input, attestations: extra },
      { verifier: verifierReturning(), registryKeys: sigstoreKeys() },
    );
    expect(result.status).toBe("verified");
    expect(result.warnings).toEqual([
      "ignored attestation with unknown predicate type https://example.com/custom",
    ]);
  });

  describe("publish attestation", () => {
    it("is invalid without registry keys, with a missing key, or with an expired key", async () => {
      const verifier = verifierReturning();
      const noKeys = await verifyProvenance(input, { verifier });
      expect(noKeys.publishAttestation).toEqual({
        status: "invalid",
        problem: "registry signing keys were not available",
      });

      const wrongKeys = await verifyProvenance(input, { verifier, registryKeys: [] });
      expect(wrongKeys.publishAttestation.problem).toMatch(/no signing key with keyid/);

      const expired = sigstoreKeys().map((key) => ({
        ...key,
        expires: "2026-01-01T00:00:00.000Z",
      }));
      // The fixture's publish attestation was logged on 2026-06-01, after this expiry.
      const expiredResult = await verifyProvenance(input, { verifier, registryKeys: expired });
      expect(expiredResult.publishAttestation.problem).toMatch(
        /expired on 2026-01-01T00:00:00.000Z, before 2026-06-01T/,
      );

      // The provenance verdict does not depend on the publish attestation.
      expect(noKeys.status).toBe("verified");
    });

    const OLD_KEY = "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA";
    /** The fixture with its publish attestation re-pointed at npm's old key (expired 2025-01-29). */
    function signedWithOldKey(edit: (tlogEntry: Record<string, unknown>) => void = () => {}) {
      const attestations = structuredClone(input.attestations);
      const publish = attestations.attestations.find(
        (a) => a.predicateType === NPM_PUBLISH_ATTESTATION_V01,
      );
      const material = publish?.bundle.verificationMaterial as {
        publicKey: { hint: string };
        tlogEntries: Record<string, unknown>[];
      };
      material.publicKey.hint = OLD_KEY;
      const [entry] = material.tlogEntries;
      if (!entry) {
        throw new Error("fixture has no tlog entry");
      }
      entry.integratedTime = "1692372338"; // 2023-08-18, when sigstore@2.0.0 was published
      edit(entry);
      return { ...input, attestations };
    }

    it("accepts a rotated registry key for an attestation logged before it expired (#78)", async () => {
      const verifier = verifierReturning();
      const result = await verifyProvenance(signedWithOldKey(), {
        verifier,
        registryKeys: sigstoreKeys(),
      });
      expect(result.publishAttestation).toEqual({ status: "verified", keyid: OLD_KEY });
      // The old key's PEM is what the signature is checked against.
      const publishCall = verifier.mock.calls.find(([bundle]) =>
        bundle.mediaType.includes("version=0.2"),
      );
      expect(publishCall?.[1].keySelector?.(OLD_KEY)).toMatch(/BEGIN PUBLIC KEY/);
    });

    it("refuses the rotated key for an attestation logged after it expired", async () => {
      const result = await verifyProvenance(
        signedWithOldKey((entry) => {
          entry.integratedTime = "1738108800"; // 2025-01-29T00:00:00Z
        }),
        { verifier: verifierReturning(), registryKeys: sigstoreKeys() },
      );
      expect(result.publishAttestation).toEqual({
        status: "invalid",
        problem: `registry signing key ${OLD_KEY} expired on 2025-01-29T00:00:00.000Z, before 2025-01-29T00:00:00.000Z`,
      });
    });

    it("does not trust a log time without a signed entry timestamp", async () => {
      // Only Rekor's SET signs integratedTime; without it the key must be valid today.
      const result = await verifyProvenance(
        signedWithOldKey((entry) => {
          delete entry.inclusionPromise;
        }),
        { verifier: verifierReturning(), registryKeys: sigstoreKeys() },
      );
      expect(result.publishAttestation.status).toBe("invalid");
      expect(result.publishAttestation.problem).toMatch(/expired on 2025-01-29/);
    });
  });
});

describe("signedLogTime", () => {
  const bundle = (entry: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
    verificationMaterial: { tlogEntries: [entry, ...extra] },
  });
  const promise = { signedEntryTimestamp: "MEUCIQ" };

  it("reads integratedTime when the entry carries a signed entry timestamp", () => {
    expect(
      signedLogTime(bundle({ integratedTime: "1692372338", inclusionPromise: promise })),
    ).toEqual(new Date("2023-08-18T15:25:38.000Z"));
    expect(
      signedLogTime(bundle({ integratedTime: 1692372338, inclusionPromise: promise })),
    ).toEqual(new Date("2023-08-18T15:25:38.000Z"));
  });

  it.each([
    ["no inclusion promise", bundle({ integratedTime: "1692372338" })],
    [
      "an empty SET",
      bundle({ integratedTime: "1692372338", inclusionPromise: { signedEntryTimestamp: "" } }),
    ],
    ["a non-numeric time", bundle({ integratedTime: "soon", inclusionPromise: promise })],
    ["a zero time", bundle({ integratedTime: "0", inclusionPromise: promise })],
    ["a negative time", bundle({ integratedTime: -5, inclusionPromise: promise })],
    [
      "two log entries",
      bundle({ integratedTime: "1", inclusionPromise: promise }, [{ integratedTime: "2" }]),
    ],
    ["no log entries", { verificationMaterial: { tlogEntries: [] } }],
    ["no verification material", {}],
  ])("gives no time for %s", (_label, input) => {
    expect(signedLogTime(input)).toBeUndefined();
  });
});

describe("crossCheck", () => {
  it("compares only fields present on both sides", () => {
    expect(
      crossCheck(
        { sourceRepositoryUri: "https://github.com/o/r", sourceRepositoryRef: "refs/heads/main" },
        {
          buildType: "x",
          repository: "https://github.com/o/r",
          workflowPath: ".github/workflows/a.yml",
          workflowRef: "refs/heads/main",
          sourceUri: "git+https://github.com/o/r@refs/heads/main",
          sourceRef: "refs/heads/main",
          commit: "a".repeat(40),
          builderId: "https://github.com/actions/runner/github-hosted",
        },
      ),
    ).toEqual([]);
  });

  it("flags an unparseable source uri against the certificate's repository and ref", () => {
    expect(
      crossCheck(
        { sourceRepositoryUri: "https://github.com/o/r", sourceRepositoryRef: "refs/heads/main" },
        {
          buildType: "x",
          repository: "https://github.com/o/r",
          workflowPath: "a.yml",
          workflowRef: "refs/heads/main",
          sourceUri: "git+https://github.com/other/x@refs/heads/main",
          commit: "a".repeat(40),
          builderId: "https://github.com/actions/runner/github-hosted",
        },
      ),
    ).toEqual([
      {
        field: "source",
        certificate: "git+https://github.com/o/r@refs/heads/main",
        predicate: "git+https://github.com/other/x@refs/heads/main",
      },
    ]);
  });
});
