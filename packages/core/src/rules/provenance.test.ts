import { describe, expect, it } from "vitest";
import { FIXTURE_REPOSITORY, fixtureContext, verifiedProvenance } from "../../test/context.js";
import type { VerifiedSource } from "../provenance/types.js";
import { provenanceRules } from "./provenance.js";

function source(overrides: Partial<VerifiedSource>): VerifiedSource {
  const base = verifiedProvenance().source;
  if (!base) {
    throw new Error("fixture provenance has no source");
  }
  return { ...base, ...overrides };
}

describe("provenanceRules", () => {
  it("has nothing to say about a clean verified provenance", async () => {
    expect(provenanceRules(await fixtureContext("clean"))).toEqual([]);
  });

  it("treats invalid provenance as critical and missing/unsupported as medium", async () => {
    const invalid = provenanceRules(
      await fixtureContext("clean", "clean", {
        provenance: verifiedProvenance({
          status: "invalid",
          problems: ["DSSE payload hash mismatch"],
          source: undefined,
        }),
      }),
    );
    expect(invalid.map((f) => `${f.severity}:${f.id}`)).toEqual(["critical:provenance-invalid"]);
    expect(invalid[0]?.detail).toContain("DSSE payload hash mismatch");

    const missing = provenanceRules(
      await fixtureContext("clean", null, {
        origin: "staged",
        provenance: verifiedProvenance({
          status: "missing",
          problems: ["no attestations"],
          source: undefined,
        }),
      }),
    );
    expect(missing[0]).toMatchObject({ id: "provenance-missing", severity: "medium" });
    expect(missing[0]?.detail).toContain("Staged versions");

    const unsupported = provenanceRules(
      await fixtureContext("clean", null, {
        provenance: verifiedProvenance({
          status: "unsupported",
          problems: ["builder gitlab"],
          source: undefined,
        }),
      }),
    );
    expect(unsupported[0]).toMatchObject({ id: "provenance-unsupported", severity: "medium" });
  });

  it("treats a forged claim (certificate vs predicate mismatch) as critical", async () => {
    const findings = provenanceRules(
      await fixtureContext("clean", "clean", {
        provenance: verifiedProvenance({
          mismatches: [{ field: "commit", certificate: "a".repeat(40), predicate: "0".repeat(40) }],
        }),
      }),
    );
    expect(findings.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "critical:provenance-claim-mismatch",
    ]);
    expect(findings[0]?.detail).toContain("commit (certificate aaaa");
  });

  it("flags the wrong repository against the user's expectation and against package.json", async () => {
    const expectation = provenanceRules(
      await fixtureContext("clean", "clean", {
        expectations: { repository: "https://github.com/other/repo" },
      }),
    );
    expect(expectation.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "critical:provenance-repository-unexpected",
    ]);

    const manifest = provenanceRules(
      await fixtureContext("clean", "clean", {
        manifestRepository: "git+https://github.com/other/repo.git",
      }),
    );
    expect(manifest.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "high:provenance-repository-differs-from-manifest",
    ]);

    // Same repository written differently is fine.
    const same = provenanceRules(
      await fixtureContext("clean", "clean", {
        manifestRepository: "github:UjjwalV01/ReleaseProof",
        expectations: { repository: `${FIXTURE_REPOSITORY}.git` },
      }),
    );
    expect(same).toEqual([]);
  });

  it("flags pull-request style triggers and non-branch/tag refs as high", async () => {
    const trigger = provenanceRules(
      await fixtureContext("clean", "clean", {
        provenance: verifiedProvenance({ source: source({ trigger: "pull_request_target" }) }),
      }),
    );
    expect(trigger.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "high:provenance-trigger-unusual",
    ]);

    const ref = provenanceRules(
      await fixtureContext("clean", "clean", {
        provenance: verifiedProvenance({ source: source({ ref: "refs/pull/42/merge" }) }),
      }),
    );
    expect(ref.map((f) => `${f.severity}:${f.id}`)).toEqual(["high:provenance-ref-unusual"]);

    for (const trigger of ["push", "release", "workflow_dispatch"]) {
      expect(
        provenanceRules(
          await fixtureContext("clean", "clean", {
            provenance: verifiedProvenance({ source: source({ trigger }) }),
          }),
        ),
      ).toEqual([]);
    }
  });

  it("notes self-hosted runners, outside signers and publish attestation problems", async () => {
    const findings = provenanceRules(
      await fixtureContext("clean", "clean", {
        provenance: verifiedProvenance({
          source: source({ runnerEnvironment: "self-hosted" }),
          signerOutsideRepository:
            "https://github.com/shared/workflows/.github/workflows/release.yml@refs/heads/main",
          publishAttestation: { status: "invalid", problem: "key not found" },
          warnings: ["ignored attestation with unknown predicate type x"],
        }),
      }),
    );
    expect(findings.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "low:provenance-runner-self-hosted",
      "medium:provenance-signer-outside-repository",
      "high:publish-attestation-invalid",
      "info:provenance-note",
    ]);
  });

  it("expects no publish attestation on a staged version, which gets one on approval", async () => {
    const provenance = verifiedProvenance({
      publishAttestation: { status: "missing" },
      attestationSource: "rekor",
    });
    const published = provenanceRules(await fixtureContext("clean", "clean", { provenance }));
    expect(published.map((f) => `${f.severity}:${f.id}`)).toEqual([
      "low:publish-attestation-missing",
    ]);
    const staged = provenanceRules(
      await fixtureContext("clean", "clean", { provenance, origin: "staged" }),
    );
    expect(staged).toEqual([]);
  });
});
