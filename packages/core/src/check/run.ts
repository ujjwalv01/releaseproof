import { compareTarballs, type DiffResult } from "../diff/compare.js";
import { readTarball, type TarballContents } from "../diff/tarball.js";
import { ToolError } from "../errors.js";
import { fetchPublished } from "../fetch/published.js";
import { fetchStaged } from "../fetch/staged.js";
import type { ReleaseArtifact } from "../fetch/types.js";
import { fetchRegistryKeys } from "../provenance/keys.js";
import { findRekorProvenance } from "../provenance/rekor.js";
import type { ProvenanceResult } from "../provenance/types.js";
import { verifyProvenance } from "../provenance/verify.js";
import {
  type RebuildResult,
  rebuildPackage,
  type StageLog,
  type StageTimeouts,
} from "../rebuild/run.js";
import { type SourceRef, sourceFromProvenance, validateSource } from "../rebuild/source.js";
import { parseSpec } from "../registry/spec.js";
import { buildVerdict, type Verdict } from "../verdict/verdict.js";

export interface CheckOptions {
  /** `<name>@<version>` of a published version. With `stageId`, a cross-check of the staged item. */
  spec?: string | undefined;
  /** Stage id (UUID) of a staged, not yet approved version. Needs a registry token. */
  stageId?: string | undefined;
  registry?: string | undefined;
  token?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  npmrcPaths?: string[] | undefined;
  /** Expected repository; also the rebuild source together with `commit` when provenance is missing. */
  repository?: string | undefined;
  commit?: string | undefined;
  image?: string | undefined;
  nodeMajor?: number | undefined;
  buildCommand?: string | undefined;
  /** Use the cached Sigstore trust root without refreshing it. */
  offline?: boolean | undefined;
  /**
   * Look a staged version's provenance up in the Rekor transparency log by the tarball's
   * SHA-512 (sent to Rekor). Needs `repository`. Defaults to true.
   */
  rekor?: boolean | undefined;
  tufCachePath?: string | undefined;
  keepVolume?: boolean | undefined;
  timeouts?: Partial<StageTimeouts> | undefined;
  memory?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

/** The core functions the check calls, injectable for tests. */
export interface CheckDeps {
  fetchPublished: typeof fetchPublished;
  fetchStaged: typeof fetchStaged;
  fetchRegistryKeys: typeof fetchRegistryKeys;
  verifyProvenance: typeof verifyProvenance;
  findRekorProvenance: typeof findRekorProvenance;
  rebuildPackage: typeof rebuildPackage;
}

const defaultDeps: CheckDeps = {
  fetchPublished,
  fetchStaged,
  fetchRegistryKeys,
  verifyProvenance,
  findRekorProvenance,
  rebuildPackage,
};

export interface RebuildReport {
  status: "ok" | "failed";
  failure?: string | undefined;
  image?: string | undefined;
  imageDigest?: string | undefined;
  toolVersion?: string | undefined;
  plan?:
    | {
        packageDir: string;
        manager: string;
        nodeMajor: number;
        nodeSource: string;
        buildSource: string;
        warnings: string[];
      }
    | undefined;
  stages: StageLog[];
  durationMs: number;
}

export interface DiffReport {
  matches: boolean;
  identical: number;
  changed: Array<{ path: string; kind: string }>;
  onlyInRelease: Array<{ path: string; size: number }>;
  onlyInRebuild: Array<{ path: string; size: number }>;
  permissionDifferences: number;
  problems: { release: string[]; rebuild: string[] };
}

/** Everything the CLI and the Action print. No tarball bytes, nothing secret. */
export interface CheckReport {
  package: {
    name: string;
    version: string;
    origin: "published" | "staged";
    registry: string;
    sha512: string;
    files: number;
  };
  provenance: ProvenanceResult;
  source: SourceRef | undefined;
  rebuild: RebuildReport | undefined;
  diff: DiffReport | undefined;
  verdict: Verdict;
  durationMs: number;
}

function rebuildReport(rebuild: RebuildResult, durationMs: number): RebuildReport {
  return {
    status: rebuild.status,
    failure: rebuild.failure,
    image: rebuild.image,
    imageDigest: rebuild.imageDigest,
    toolVersion: rebuild.toolVersion,
    plan: rebuild.plan
      ? {
          packageDir: rebuild.plan.packageDir,
          manager: rebuild.plan.manager.spec ?? rebuild.plan.manager.name,
          nodeMajor: rebuild.plan.nodeMajor,
          nodeSource: rebuild.plan.nodeSource,
          buildSource: rebuild.plan.buildSource,
          warnings: rebuild.plan.warnings,
        }
      : undefined,
    stages: rebuild.stages,
    durationMs,
  };
}

function diffReport(diff: DiffResult): DiffReport {
  return {
    matches: diff.matches,
    identical: diff.identical.length,
    changed: diff.changed.map((change) => ({ path: change.path, kind: change.kind })),
    onlyInRelease: diff.onlyInRelease.map((entry) => ({ path: entry.path, size: entry.size })),
    onlyInRebuild: diff.onlyInRebuild.map((entry) => ({ path: entry.path, size: entry.size })),
    permissionDifferences: diff.info.length,
    problems: diff.problems,
  };
}

/**
 * Decides where to rebuild from: certified provenance first, else the commit the user named
 * together with its repository. `repository` on its own is only an expectation.
 */
export function chooseSource(
  provenance: ProvenanceResult,
  options: CheckOptions,
): SourceRef | undefined {
  const certified = sourceFromProvenance(provenance);
  if (certified) {
    return certified;
  }
  if (options.commit) {
    if (!options.repository) {
      throw new ToolError("--commit needs --repo to say which repository to rebuild from");
    }
    return validateSource({
      repository: options.repository,
      commit: options.commit,
      verified: false,
    });
  }
  return undefined;
}

/**
 * npm hides a staged version's attestations until approval but has already written the
 * provenance to Rekor. Looks it up there; anything short of a verified entry from the
 * expected repository leaves the result as it was, with a note saying why.
 */
async function provenanceFromRekor(
  artifact: ReleaseArtifact,
  provenance: ProvenanceResult,
  options: CheckOptions,
  deps: CheckDeps,
  log: (line: string) => void,
): Promise<ProvenanceResult> {
  const withNotes = (notes: string[]) => ({
    ...provenance,
    warnings: [...provenance.warnings, ...notes],
  });
  if (!options.repository) {
    return withNotes([
      "pass --repo to look up the staged version's provenance in the Rekor transparency log",
    ]);
  }
  log("looking up the provenance in the Rekor transparency log");
  try {
    const found = await deps.findRekorProvenance(
      { purl: artifact.purl, sha512Hex: artifact.digests.sha512Hex },
      {
        expectedRepository: options.repository,
        offline: options.offline,
        tufCachePath: options.tufCachePath,
      },
    );
    return found.provenance ?? withNotes(found.notes);
  } catch (error) {
    if (!(error instanceof ToolError)) {
      throw error;
    }
    return withNotes([`Rekor lookup failed: ${error.message}`]);
  }
}

/**
 * The whole check: fetch, verify provenance, rebuild from the source, diff, decide.
 * Throws ToolError only for environment problems (registry unreachable, bad options,
 * Docker missing); everything about the package itself ends up in the verdict.
 */
export async function runCheck(
  options: CheckOptions,
  deps: CheckDeps = defaultDeps,
): Promise<CheckReport> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const registryOptions = {
    registry: options.registry,
    token: options.token,
    env: options.env,
    npmrcPaths: options.npmrcPaths,
  };

  let artifact: ReleaseArtifact;
  if (options.stageId) {
    log(`fetching staged version ${options.stageId}`);
    artifact = await deps.fetchStaged(options.stageId, registryOptions);
    if (options.spec) {
      const expected = parseSpec(options.spec);
      if (expected.name !== artifact.name || expected.version !== artifact.version) {
        throw new ToolError(
          `Staged ${options.stageId} is ${artifact.name}@${artifact.version}, not ${options.spec}`,
        );
      }
    }
  } else if (options.spec) {
    log(`fetching ${options.spec}`);
    artifact = await deps.fetchPublished(options.spec, registryOptions);
  } else {
    throw new ToolError("Give a package as <name>@<version>, or --stage <id> for a staged version");
  }
  const registry = artifact.origin.registry;

  let registryKeys: Awaited<ReturnType<typeof fetchRegistryKeys>> = null;
  try {
    registryKeys = await deps.fetchRegistryKeys({ ...registryOptions, registry });
  } catch (error) {
    if (!(error instanceof ToolError)) {
      throw error;
    }
    log(`registry keys unavailable: ${error.message}`);
  }
  log("verifying provenance");
  let provenance = await deps.verifyProvenance(
    {
      purl: artifact.purl,
      sha512Hex: artifact.digests.sha512Hex,
      attestations: artifact.attestations,
    },
    { registryKeys, offline: options.offline, tufCachePath: options.tufCachePath },
  );
  if (
    artifact.origin.kind === "staged" &&
    provenance.status === "missing" &&
    options.rekor !== false
  ) {
    provenance = await provenanceFromRekor(artifact, provenance, options, deps, log);
  }
  log(
    `provenance: ${provenance.status}${provenance.attestationSource === "rekor" ? " (from Rekor)" : ""}`,
  );

  const source = chooseSource(provenance, options);
  const release = readTarball(artifact.tarball);

  let rebuild: RebuildResult | undefined;
  let rebuilt: TarballContents | undefined;
  let diff: DiffResult | undefined;
  let rebuildDurationMs = 0;
  if (source) {
    log(`rebuilding from ${source.repository}@${source.commit.slice(0, 7)}`);
    const rebuildStarted = Date.now();
    rebuild = await deps.rebuildPackage(
      source,
      { name: artifact.name, version: artifact.version },
      {
        overrides: {
          image: options.image,
          nodeMajor: options.nodeMajor,
          buildCommand: options.buildCommand,
        },
        keepVolume: options.keepVolume,
        timeouts: options.timeouts,
        memory: options.memory,
        log,
      },
    );
    rebuildDurationMs = Date.now() - rebuildStarted;
    if (rebuild.status === "ok" && rebuild.tarball) {
      rebuilt = readTarball(rebuild.tarball);
      diff = compareTarballs(release, rebuilt);
      log(
        `compared: ${diff.identical.length} identical, ${diff.changed.length} changed, ${diff.onlyInRelease.length} only in release, ${diff.onlyInRebuild.length} only in rebuild`,
      );
    } else {
      log(`rebuild failed: ${rebuild.failure ?? "unknown"}`);
    }
  } else {
    log("no source to rebuild from");
  }

  const verdict = buildVerdict({
    artifact,
    provenance,
    source,
    rebuild,
    release,
    rebuilt,
    diff,
    expectations: { repository: options.repository },
  });

  return {
    package: {
      name: artifact.name,
      version: artifact.version,
      origin: artifact.origin.kind,
      registry,
      sha512: artifact.digests.sha512Hex,
      files: [...release.entries.values()].filter((entry) => entry.kind !== "directory").length,
    },
    provenance,
    source,
    rebuild: rebuild ? rebuildReport(rebuild, rebuildDurationMs) : undefined,
    diff: diff ? diffReport(diff) : undefined,
    verdict,
    durationMs: Date.now() - started,
  };
}
