import { describe, expect, it } from "vitest";
import { compareTarballs } from "../diff/compare.js";
import { readTarball } from "../diff/tarball.js";
import { fetchPublished } from "../fetch/published.js";
import { fetchRegistryKeys } from "../provenance/keys.js";
import { verifyProvenance } from "../provenance/verify.js";
import { registryJson } from "../registry/client.js";
import { rebuildPackage } from "./run.js";
import { sourceFromProvenance } from "./source.js";

/**
 * Real end-to-end rebuilds in Docker. Slow (image pulls, installs, builds) and needs the
 * network. Opt in with RELEASEPROOF_DOCKER_TESTS=1.
 */
describe.skipIf(!process.env.RELEASEPROOF_DOCKER_TESTS)("rebuildPackage (docker)", () => {
  async function rebuildAndCompare(spec: string) {
    const artifact = await fetchPublished(spec);
    const provenance = await verifyProvenance(
      {
        purl: artifact.purl,
        sha512Hex: artifact.digests.sha512Hex,
        attestations: artifact.attestations,
      },
      { registryKeys: await fetchRegistryKeys() },
    );
    expect(provenance.status, provenance.problems.join("; ")).toBe("verified");
    const source = sourceFromProvenance(provenance);
    if (!source) {
      throw new Error("no verified source");
    }
    const rebuild = await rebuildPackage(
      source,
      { name: artifact.name, version: artifact.version },
      {
        log: (line) => console.log(`[${spec}] ${line}`),
        // Both packages' output is independent of the Node major; one image keeps the test
        // from pulling ~400 MB per major (the planner's choice is covered by unit tests).
        overrides: { nodeMajor: 22 },
      },
    );
    if (rebuild.status !== "ok" || !rebuild.tarball) {
      console.log(JSON.stringify(rebuild.stages, null, 2));
      throw new Error(`rebuild failed: ${rebuild.failure}`);
    }
    const diff = compareTarballs(readTarball(artifact.tarball), readTarball(rebuild.tarball));
    console.log(
      `[${spec}] image ${rebuild.image} (${rebuild.imageDigest}), ${rebuild.toolVersion}, ` +
        `build: ${rebuild.plan?.buildSource}; identical ${diff.identical.length}, changed ${diff.changed.length}, ` +
        `only in release ${diff.onlyInRelease.length}, only in rebuild ${diff.onlyInRebuild.length}`,
    );
    for (const change of diff.changed) {
      console.log(
        `[${spec}] changed ${change.path} (${change.kind})\n${change.patch ?? "(no patch)"}`,
      );
    }
    for (const entry of diff.onlyInRelease) {
      console.log(`[${spec}] only in release: ${entry.path}`);
    }
    for (const entry of diff.onlyInRebuild) {
      console.log(`[${spec}] only in rebuild: ${entry.path}`);
    }
    return { rebuild, diff };
  }

  it(
    "rebuilds semver@7.8.5 (npm, no build step) and it matches the release",
    async () => {
      const { diff } = await rebuildAndCompare("semver@7.8.5");
      expect(diff.problems).toEqual({ release: [], rebuild: [] });
      expect(diff.matches).toBe(true);
    },
    20 * 60_000,
  );

  it(
    "rebuilds sigstore@5.0.0 (npm workspaces, tsc build) and it matches the release",
    async () => {
      const { diff } = await rebuildAndCompare("sigstore@5.0.0");
      expect(diff.problems).toEqual({ release: [], rebuild: [] });
      expect(diff.matches).toBe(true);
    },
    30 * 60_000,
  );
  it(
    "rebuilds the latest published releaseproof release and it matches the release",
    async () => {
      const metadata = await registryJson<unknown>("/releaseproof");
      const distTags =
        typeof metadata === "object" && metadata !== null && "dist-tags" in metadata
          ? metadata["dist-tags"]
          : null;
      if (
        typeof distTags !== "object" ||
        distTags === null ||
        !("latest" in distTags) ||
        typeof distTags.latest !== "string" ||
        distTags.latest.length === 0
      ) {
        throw new Error("npm registry did not provide releaseproof's dist-tags.latest");
      }

      const version = distTags.latest;
      const spec = `releaseproof@${version}`;
      console.log(`[releaseproof] dist-tags.latest resolves to ${version}`);

      const { diff } = await rebuildAndCompare(spec);
      expect(diff.problems).toEqual({ release: [], rebuild: [] });
      expect(diff.matches).toBe(true);
    },
    30 * 60_000,
  );
});
