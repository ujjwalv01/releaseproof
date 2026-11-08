import { createHash, randomBytes } from "node:crypto";
import { errorMessage, ToolError } from "../errors.js";
import {
  type ContainerResult,
  type ContainerSpec,
  createDockerClient,
  type DockerClient,
} from "./docker.js";
import { InspectionError, parseInspection, type RepoInspection } from "./inspect.js";
import {
  type BuildPlan,
  type Command,
  DEFAULT_NODE_MAJOR,
  type PlanOverrides,
  planBuild,
  validateImageReference,
} from "./plan.js";
import {
  CLONE_SCRIPT,
  INIT_SCRIPT,
  INSPECT_JS,
  INSPECTION_MARKER,
  renderBuildScript,
  renderInstallScript,
  TOOL_VERSION_MARKER,
} from "./scripts.js";
import type { SourceRef } from "./source.js";

export type StageName = "init" | "clone" | "install" | "build" | "export";

export interface StageLog {
  stage: StageName;
  image: string;
  network: "bridge" | "none";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last part of stderr (and stdout for text stages). */
  output: string;
}

export interface RebuildResult {
  status: "ok" | "failed";
  /** Why it failed, when it did. */
  failure?: string | undefined;
  source: SourceRef;
  inspection?: RepoInspection | undefined;
  plan?: BuildPlan | undefined;
  image?: string | undefined;
  imageDigest?: string | undefined;
  /** Exact package manager version that ran, e.g. "pnpm 10.4.1". */
  toolVersion?: string | undefined;
  tarball?: Buffer | undefined;
  tarballSha256?: string | undefined;
  stages: StageLog[];
  volume: string;
}

export interface StageTimeouts {
  cloneMs: number;
  installMs: number;
  buildMs: number;
}

export const DEFAULT_TIMEOUTS: StageTimeouts = {
  cloneMs: 10 * 60_000,
  installMs: 20 * 60_000,
  buildMs: 30 * 60_000,
};

export interface RebuildOptions {
  docker?: DockerClient | undefined;
  overrides?: PlanOverrides | undefined;
  timeouts?: Partial<StageTimeouts> | undefined;
  memory?: string | undefined;
  pidsLimit?: number | undefined;
  /** Keep the Docker volume for debugging instead of deleting it. */
  keepVolume?: boolean | undefined;
  /** Progress lines for the UI. */
  log?: ((line: string) => void) | undefined;
  /** Injectable id source, for deterministic names in tests. */
  volumeId?: string | undefined;
}

const OUTPUT_TAIL = 6000;
const UNPRIVILEGED = "1000:1000";

function readToolVersion(stdout: Buffer): string | undefined {
  return new RegExp(`^${TOOL_VERSION_MARKER} (\\S+)$`, "m").exec(stdout.toString("utf8"))?.[1];
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
}

function textTail(result: ContainerResult, includeStdout: boolean): string {
  const parts = [result.stderr];
  if (includeStdout) {
    parts.push(result.stdout.toString("utf8"));
  }
  return tail(parts.filter((part) => part.trim() !== "").join("\n"));
}

/**
 * Rebuilds `target` from `source` in Docker and returns the packed tarball. Never throws
 * for a failing build: that is a `failed` result with the stage log. Throws ToolError for
 * an invalid image override or when Docker itself is unusable.
 */
export async function rebuildPackage(
  source: SourceRef,
  target: { name: string; version: string },
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  if (options.overrides?.image !== undefined) validateImageReference(options.overrides.image);
  const docker = options.docker ?? createDockerClient();
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const memory = options.memory ?? "4g";
  const pidsLimit = options.pidsLimit ?? 4096;
  const log = options.log ?? (() => {});
  const volume = `releaseproof-${options.volumeId ?? randomBytes(6).toString("hex")}`;
  const baseImage = `node:${DEFAULT_NODE_MAJOR}-bookworm`;
  const result: RebuildResult = { status: "failed", source, stages: [], volume };

  const fail = (failure: string): RebuildResult => {
    result.status = "failed";
    result.failure = failure;
    return result;
  };

  async function runStage(
    stage: StageName,
    spec: Omit<ContainerSpec, "name" | "volume" | "memory" | "pidsLimit" | "workdir" | "user"> & {
      user?: string | undefined;
    },
    includeStdoutInLog: boolean,
  ): Promise<ContainerResult> {
    log(`${stage}: ${spec.image} (network ${spec.network})`);
    const outcome = await docker.run({
      ...spec,
      name: `${volume}-${stage}`,
      volume,
      memory,
      pidsLimit,
      workdir: "/work",
      user: spec.user ?? UNPRIVILEGED,
    });
    result.stages.push({
      stage,
      image: spec.image,
      network: spec.network,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      output: textTail(outcome, includeStdoutInLog),
    });
    return outcome;
  }

  function stageFailure(stage: StageName, outcome: ContainerResult): string {
    const why = outcome.timedOut
      ? "timed out"
      : `exited with code ${outcome.exitCode ?? "unknown"}`;
    return `${stage} stage ${why}`;
  }

  const serverVersion = await docker.serverVersion();
  log(`docker engine ${serverVersion}`);
  await docker.createVolume(volume);
  try {
    await docker.pull(baseImage);

    const init = await runStage(
      "init",
      {
        image: baseImage,
        network: "none",
        env: {},
        argv: ["bash", "-c", INIT_SCRIPT],
        timeoutMs: 60_000,
        user: "0:0",
        // Root in the container still lacks CAP_CHOWN after --cap-drop ALL; the volume is
        // empty at this point, so granting it here exposes nothing.
        capAdd: ["CHOWN"],
      },
      true,
    );
    if (init.exitCode !== 0) {
      return fail(stageFailure("init", init));
    }

    const cloneEnv: Record<string, string> = {
      RP_REPOSITORY: source.repository,
      RP_COMMIT: source.commit,
      RP_INSPECT_JS: INSPECT_JS,
    };
    if (source.workflowPath) {
      cloneEnv.RP_WORKFLOW = source.workflowPath;
    }
    const clone = await runStage(
      "clone",
      {
        image: baseImage,
        network: "bridge",
        env: cloneEnv,
        argv: ["bash", "-c", CLONE_SCRIPT],
        timeoutMs: timeouts.cloneMs,
      },
      false,
    );
    if (clone.exitCode !== 0) {
      return fail(stageFailure("clone", clone));
    }
    const stdout = clone.stdout.toString("utf8");
    const markerAt = stdout.lastIndexOf(`${INSPECTION_MARKER}\n`);
    let inspection: RepoInspection;
    try {
      if (markerAt === -1) {
        throw new InspectionError("clone stage printed no inspection");
      }
      inspection = parseInspection(
        JSON.parse(stdout.slice(markerAt + INSPECTION_MARKER.length + 1)),
      );
    } catch (error) {
      return fail(`could not read the repository inspection: ${errorMessage(error)}`);
    }
    if (inspection.commit !== source.commit) {
      return fail(`checked out ${inspection.commit} but expected ${source.commit}`);
    }
    result.inspection = inspection;

    const planned = planBuild({ inspection, target, overrides: options.overrides });
    if (!planned.ok) {
      return fail(planned.reason);
    }
    const plan = planned.plan;
    result.plan = plan;
    result.image = plan.image;
    for (const warning of plan.warnings) {
      log(`warning: ${warning}`);
    }
    if (plan.image !== baseImage) {
      await docker.pull(plan.image);
    }
    result.imageDigest = await docker.imageDigest(plan.image);

    let toolVersion: string | undefined;
    if (plan.install) {
      const install = await runStage(
        "install",
        {
          image: plan.image,
          network: "bridge",
          env: {},
          argv: ["bash", "-c", renderInstallScript(plan)],
          timeoutMs: timeouts.installMs,
        },
        true, // package managers print their errors on stdout as often as stderr
      );
      if (install.exitCode !== 0) {
        return fail(stageFailure("install", install));
      }
      toolVersion = readToolVersion(install.stdout);
    } else {
      log(`install: skipped (${plan.installSkipped ?? "not needed"})`);
    }
    const buildPlan = pinManagerVersion(plan, toolVersion);
    result.plan = buildPlan;

    const build = await runStage(
      "build",
      {
        image: plan.image,
        network: "none",
        env: {},
        argv: ["bash", "-c", renderBuildScript(buildPlan)],
        timeoutMs: timeouts.buildMs,
      },
      true,
    );
    if (build.exitCode !== 0) {
      return fail(stageFailure("build", build));
    }
    toolVersion ??= readToolVersion(build.stdout);
    result.toolVersion = toolVersion
      ? `${buildPlan.manager.name.replace("-berry", "").replace("-classic", "")} ${toolVersion}`
      : undefined;
    const expectedSha = /^([0-9a-f]{64}) {2}package\.tgz$/m.exec(
      build.stdout.toString("utf8"),
    )?.[1];
    if (!expectedSha) {
      return fail("build stage did not report the tarball digest");
    }

    const exported = await runStage(
      "export",
      {
        image: plan.image,
        network: "none",
        env: {},
        argv: ["cat", "/work/out/package.tgz"],
        timeoutMs: 5 * 60_000,
        volumeReadOnly: true,
      },
      false,
    );
    if (exported.exitCode !== 0) {
      return fail(stageFailure("export", exported));
    }
    const sha = createHash("sha256").update(exported.stdout).digest("hex");
    if (sha !== expectedSha) {
      return fail(`exported tarball digest ${sha} does not match the build stage's ${expectedSha}`);
    }
    result.tarball = exported.stdout;
    result.tarballSha256 = sha;
    result.status = "ok";
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    return fail(`unexpected error: ${errorMessage(error)}`);
  } finally {
    if (!options.keepVolume) {
      await docker.removeVolume(volume).catch(() => undefined);
    }
  }
}

/**
 * The offline build stage must not resolve a floating spec like `pnpm@10` (that needs the
 * network), so once the install stage reports the exact version we pin every command to it.
 */
export function pinManagerVersion(plan: BuildPlan, version: string | undefined): BuildPlan {
  const spec = plan.manager.spec;
  if (!spec || !version || spec.includes(".")) {
    return plan;
  }
  const exact = `${spec.split("@")[0]}@${version}`;
  const pin = (command: Command): Command => ({
    ...command,
    argv: command.argv.map((token, index) => (index === 1 && token === spec ? exact : token)),
  });
  return {
    ...plan,
    manager: { ...plan.manager, spec: exact },
    install: plan.install ? pin(plan.install) : undefined,
    installExtra: plan.installExtra ? pin(plan.installExtra) : undefined,
    rebuildDeps: plan.rebuildDeps ? pin(plan.rebuildDeps) : undefined,
    build: plan.build ? pin(plan.build) : undefined,
    pack: pin(plan.pack),
  };
}
