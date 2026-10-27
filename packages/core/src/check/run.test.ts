import { describe, expect, it, vi } from "vitest";
import { FIXTURE_REPOSITORY, verifiedProvenance } from "../../test/context.js";
import { packFixture } from "../../test/tarballs.js";
import { ToolError } from "../errors.js";
import { computeDigests } from "../fetch/digests.js";
import type { ReleaseArtifact } from "../fetch/types.js";
import type { ProvenanceResult } from "../provenance/types.js";
import type { RebuildResult } from "../rebuild/run.js";
import { type CheckDeps, runCheck } from "./run.js";

async function artifactFor(fixture: string): Promise<ReleaseArtifact> {
  const tarball = await packFixture(fixture);
  return {
    origin: { kind: "published", registry: "https://registry.npmjs.org/" },
    name: "@releaseproof/fixture",
    version: "1.0.0",
    purl: "pkg:npm/%40releaseproof/fixture@1.0.0",
    tarball,
    digests: computeDigests(tarball),
    dist: {},
    hints: { repository: `git+${FIXTURE_REPOSITORY}.git` },
    attestations: null,
  };
}

function depsFor(input: {
  release: string;
  rebuilt?: string | undefined;
  provenance?: ProvenanceResult | undefined;
  rebuild?: Partial<RebuildResult> | undefined;
}): CheckDeps & { calls: { rebuild: unknown[] } } {
  const calls = { rebuild: [] as unknown[] };
  return {
    calls,
    fetchPublished: async () => artifactFor(input.release),
    fetchStaged: async (stageId) => ({
      ...(await artifactFor(input.release)),
      origin: {
        kind: "staged",
        registry: "https://registry.npmjs.org/",
        stageId,
        item: { id: stageId, packageName: "@releaseproof/fixture", version: "1.0.0" },
      },
    }),
    fetchRegistryKeys: async () => [],
    verifyProvenance: async () => input.provenance ?? verifiedProvenance(),
    findRekorProvenance: async () => ({
      provenance: undefined,
      notes: ["the Rekor transparency log has no provenance for this tarball"],
    }),
    rebuildPackage: async (source, target, options) => {
      calls.rebuild.push({ source, target, options });
      const tarball = await packFixture(input.rebuilt ?? "clean");
      return {
        status: "ok",
        source,
        stages: [],
        volume: "v",
        tarball,
        image: "node:22-bookworm",
        toolVersion: "npm 10.9.9",
        ...input.rebuild,
      };
    },
  };
}

const missing = verifiedProvenance({
  status: "missing",
  problems: ["no attestations"],
  source: undefined,
});

describe("runCheck", () => {
  it("fetches, verifies, rebuilds from the certified source, diffs and decides", async () => {
    const deps = depsFor({ release: "attacked-postinstall" });
    const log = vi.fn();
    const report = await runCheck({ spec: "@releaseproof/fixture@1.0.0", log }, deps);

    expect(report.verdict.status).toBe("differs-from-source");
    expect(report.verdict.exitCode).toBe(1);
    expect(report.package).toMatchObject({
      name: "@releaseproof/fixture",
      version: "1.0.0",
      files: 6,
    });
    expect(report.source).toMatchObject({ repository: FIXTURE_REPOSITORY, verified: true });
    expect(report.rebuild).toMatchObject({
      status: "ok",
      image: "node:22-bookworm",
      toolVersion: "npm 10.9.9",
    });
    expect(report.diff).toMatchObject({
      matches: false,
      identical: 4,
      onlyInRelease: [{ path: "lib/setup.js" }],
    });
    expect(report.verdict.findings.map((f) => f.id)).toEqual([
      "install-script-added",
      "file-added",
    ]);
    expect(deps.calls.rebuild).toHaveLength(1);
    expect(log.mock.calls.map((c) => c[0])).toContain("provenance: verified");
  });

  it("matches a clean release", async () => {
    const report = await runCheck(
      { spec: "@releaseproof/fixture@1.0.0" },
      depsFor({ release: "clean" }),
    );
    expect(report.verdict.status).toBe("matches-source");
    expect(report.verdict.exitCode).toBe(0);
    expect(report.diff?.identical).toBe(5);
  });

  it("cannot verify without provenance and without --repo/--commit, and does not rebuild", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    const report = await runCheck({ spec: "@releaseproof/fixture@1.0.0" }, deps);
    expect(report.verdict.status).toBe("could-not-verify");
    expect(report.source).toBeUndefined();
    expect(report.rebuild).toBeUndefined();
    expect(deps.calls.rebuild).toHaveLength(0);
  });

  it("rebuilds from --repo/--commit when provenance is missing, marked as not certified", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    const report = await runCheck(
      {
        spec: "@releaseproof/fixture@1.0.0",
        repository: FIXTURE_REPOSITORY,
        commit: "b".repeat(40),
      },
      deps,
    );
    expect(report.source).toEqual({
      repository: FIXTURE_REPOSITORY,
      commit: "b".repeat(40),
      ref: undefined,
      workflowPath: undefined,
      verified: false,
    });
    expect(report.verdict.status).toBe("matches-source");
    expect(report.verdict.summary).toContain("not certified by provenance");
  });

  it("needs --repo to go with --commit, and treats --repo alone as an expectation only", async () => {
    await expect(
      runCheck(
        { spec: "@releaseproof/fixture@1.0.0", commit: "b".repeat(40) },
        depsFor({ release: "clean", provenance: missing }),
      ),
    ).rejects.toThrow(/--commit needs --repo/);
    const deps = depsFor({ release: "clean", provenance: missing });
    const report = await runCheck(
      { spec: "@releaseproof/fixture@1.0.0", repository: FIXTURE_REPOSITORY },
      deps,
    );
    expect(report.verdict.status).toBe("could-not-verify");
    expect(report.source).toBeUndefined();
    expect(deps.calls.rebuild).toHaveLength(0);
  });

  it("treats --repo as an expectation when provenance is verified", async () => {
    const report = await runCheck(
      { spec: "@releaseproof/fixture@1.0.0", repository: "https://github.com/someone/else" },
      depsFor({ release: "clean" }),
    );
    expect(report.source?.verified).toBe(true);
    expect(report.verdict.status).toBe("differs-from-source");
    expect(report.verdict.findings[0]?.id).toBe("provenance-repository-unexpected");
  });

  it("reports a failed rebuild as could-not-verify with the failure", async () => {
    const deps = depsFor({
      release: "clean",
      rebuild: { status: "failed", failure: "build stage timed out", tarball: undefined },
    });
    const report = await runCheck({ spec: "@releaseproof/fixture@1.0.0" }, deps);
    expect(report.verdict.status).toBe("could-not-verify");
    expect(report.rebuild).toMatchObject({ status: "failed", failure: "build stage timed out" });
    expect(report.diff).toBeUndefined();
  });

  it("passes build overrides and progress logging to the rebuild", async () => {
    const deps = depsFor({ release: "clean" });
    await runCheck(
      {
        spec: "@releaseproof/fixture@1.0.0",
        image: "node:24-bookworm",
        nodeMajor: 24,
        buildCommand: "make",
        keepVolume: true,
      },
      deps,
    );
    expect(deps.calls.rebuild[0]).toMatchObject({
      options: {
        overrides: { image: "node:24-bookworm", nodeMajor: 24, buildCommand: "make" },
        keepVolume: true,
      },
    });
  });
});

describe("runCheck with a staged version", () => {
  const stageId = "123e4567-e89b-12d3-a456-426614174000";

  it("fetches the staged tarball and rebuilds from --repo/--commit, since staging has no provenance", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    const report = await runCheck(
      { stageId, repository: FIXTURE_REPOSITORY, commit: "b".repeat(40) },
      deps,
    );
    expect(report.package.origin).toBe("staged");
    expect(report.verdict.status).toBe("matches-source");
    expect(report.verdict.summary).toContain("not certified by provenance");
  });

  it("certifies the source with provenance found in Rekor, ahead of --commit", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    const fromRekor = verifiedProvenance({
      attestationSource: "rekor",
      publishAttestation: { status: "missing" },
    });
    const findRekor = vi.fn<CheckDeps["findRekorProvenance"]>(async () => ({
      provenance: fromRekor,
      notes: [],
    }));
    const log = vi.fn();
    const report = await runCheck(
      {
        stageId,
        repository: FIXTURE_REPOSITORY,
        commit: "b".repeat(40),
        offline: true,
        tufCachePath: "/cache",
        log,
      },
      { ...deps, findRekorProvenance: findRekor },
    );

    const artifact = await deps.fetchStaged(stageId);
    expect(findRekor).toHaveBeenCalledWith(
      { purl: artifact.purl, sha512Hex: artifact.digests.sha512Hex },
      { expectedRepository: FIXTURE_REPOSITORY, offline: true, tufCachePath: "/cache" },
    );
    expect(report.provenance).toBe(fromRekor);
    expect(report.source).toMatchObject({ commit: "a".repeat(40), verified: true });
    expect(report.verdict.status).toBe("matches-source");
    expect(report.verdict.summary).not.toContain("not certified");
    // A staged version is attested by the registry only on approval; that is not a finding.
    expect(report.verdict.findings.map((f) => f.id)).not.toContain("publish-attestation-missing");
    expect(log).toHaveBeenCalledWith("provenance: verified (from Rekor)");
  });

  it("falls back to the named source with Rekor's notes when nothing there counts", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    const report = await runCheck(
      { stageId, repository: FIXTURE_REPOSITORY, commit: "b".repeat(40) },
      deps,
    );
    expect(report.provenance.status).toBe("missing");
    expect(report.provenance.warnings).toEqual([
      "the Rekor transparency log has no provenance for this tarball",
    ]);
    expect(report.source).toMatchObject({ commit: "b".repeat(40), verified: false });
    expect(missing.warnings).toEqual([]);
  });

  it("reports a failed Rekor lookup as a note, not as a tool error", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    const report = await runCheck(
      { stageId, repository: FIXTURE_REPOSITORY, commit: "b".repeat(40) },
      {
        ...deps,
        findRekorProvenance: async () => {
          throw new ToolError("Rekor returned HTTP 503 for api/v1/index/retrieve");
        },
      },
    );
    expect(report.provenance.warnings).toEqual([
      "Rekor lookup failed: Rekor returned HTTP 503 for api/v1/index/retrieve",
    ]);
    expect(report.verdict.status).toBe("matches-source");
  });

  it("does not ask Rekor without --repo, with rekor: false, or for a published version", async () => {
    const findRekor = vi.fn<CheckDeps["findRekorProvenance"]>();
    const deps = {
      ...depsFor({ release: "clean", provenance: missing }),
      findRekorProvenance: findRekor,
    };

    const noRepo = await runCheck({ stageId }, deps);
    expect(noRepo.provenance.warnings).toEqual([
      "pass --repo to look up the staged version's provenance in the Rekor transparency log",
    ]);
    await runCheck({ stageId, repository: FIXTURE_REPOSITORY, rekor: false }, deps);
    await runCheck({ spec: "@releaseproof/fixture@1.0.0", repository: FIXTURE_REPOSITORY }, deps);
    expect(findRekor).not.toHaveBeenCalled();
  });

  it("cross-checks the staged item against a package spec when both are given", async () => {
    const deps = depsFor({ release: "clean", provenance: missing });
    await expect(runCheck({ stageId, spec: "@releaseproof/fixture@9.9.9" }, deps)).rejects.toThrow(
      /is @releaseproof\/fixture@1.0.0, not @releaseproof\/fixture@9.9.9/,
    );
    const report = await runCheck({ stageId, spec: "@releaseproof/fixture@1.0.0" }, deps);
    expect(report.verdict.status).toBe("could-not-verify");
  });

  it("needs either a package spec or a stage id", async () => {
    await expect(runCheck({}, depsFor({ release: "clean" }))).rejects.toThrow(
      /Give a package as <name>@<version>, or --stage <id>/,
    );
  });
});
