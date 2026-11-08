import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import type { ContainerResult, ContainerSpec, DockerClient } from "./docker.js";
import type { RepoInspection } from "./inspect.js";
import type { BuildPlan } from "./plan.js";
import { pinManagerVersion, rebuildPackage, type StageName } from "./run.js";
import { INSPECTION_MARKER, TOOL_VERSION_MARKER } from "./scripts.js";
import type { SourceRef } from "./source.js";

const commit = "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a";
const source: SourceRef = {
  repository: "https://github.com/o/r",
  commit,
  ref: "refs/heads/main",
  workflowPath: ".github/workflows/release.yml",
  verified: true,
};
const target = { name: "tiny", version: "1.0.0" };
const tarball = Buffer.from("pretend this is package.tgz");
const tarballSha = createHash("sha256").update(tarball).digest("hex");

const inspection: RepoInspection = {
  commit,
  lockfiles: ["pnpm-lock.yaml"],
  lockfileDetails: { pnpm: "9.0" },
  nodeVersionFiles: {},
  hasYarnrcYml: false,
  hasPnpmWorkspace: false,
  hasLernaJson: false,
  hasSubmodules: false,
  packages: [{ dir: ".", name: "tiny", version: "1.0.0", scripts: { build: "tsc" } }],
  workflow: "node-version: 20\n",
};

type Responder = (spec: ContainerSpec) => Partial<ContainerResult>;

class FakeDocker implements DockerClient {
  specs: ContainerSpec[] = [];
  volumes: string[] = [];
  removed: string[] = [];
  pulled: string[] = [];
  constructor(private readonly responses: Partial<Record<StageName, Responder>>) {}
  async serverVersion() {
    return "29.8.2";
  }
  async pull(image: string) {
    this.pulled.push(image);
  }
  async imageDigest(image: string) {
    return `${image.split(":")[0]}@sha256:${"ab".repeat(32)}`;
  }
  async createVolume(name: string) {
    this.volumes.push(name);
  }
  async removeVolume(name: string) {
    this.removed.push(name);
  }
  async run(spec: ContainerSpec): Promise<ContainerResult> {
    this.specs.push(spec);
    const stage = spec.name.split("-").pop() as StageName;
    return {
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: "",
      timedOut: false,
      durationMs: 5,
      ...this.responses[stage]?.(spec),
    };
  }
  stages(): string[] {
    return this.specs.map((spec) => spec.name.split("-").pop() ?? "");
  }
}

function happyPath(overrides: Partial<Record<StageName, Responder>> = {}): FakeDocker {
  return new FakeDocker({
    clone: () => ({
      stdout: Buffer.from(`git noise\n${INSPECTION_MARKER}\n${JSON.stringify(inspection)}`),
    }),
    install: () => ({ stdout: Buffer.from(`${TOOL_VERSION_MARKER} 10.14.0\n`) }),
    build: () => ({ stdout: Buffer.from(`${tarballSha}  package.tgz\n`) }),
    export: () => ({ stdout: tarball }),
    ...overrides,
  });
}

describe("rebuildPackage", () => {
  it.each(["--privileged", "node:", "node:22\n", "node\0", ""])(
    "rejects image %j before any Docker call",
    async (image) => {
      const docker = happyPath();
      const calls = [
        "serverVersion",
        "createVolume",
        "pull",
        "imageDigest",
        "run",
        "removeVolume",
      ].map((method) => vi.spyOn(docker, method as keyof DockerClient));
      await expect(
        rebuildPackage(source, target, { docker, overrides: { image } }),
      ).rejects.toThrow(ToolError);
      for (const call of calls) expect(call).not.toHaveBeenCalled();
    },
  );

  it("runs init, clone, install, build and export on one volume and returns the tarball", async () => {
    const docker = happyPath();
    const result = await rebuildPackage(source, target, { docker, volumeId: "abc" });

    expect(result.status).toBe("ok");
    expect(result.failure).toBeUndefined();
    expect(result.tarball?.equals(tarball)).toBe(true);
    expect(result.tarballSha256).toBe(tarballSha);
    expect(result.toolVersion).toBe("pnpm 10.14.0");
    expect(result.image).toBe("node:20-bookworm");
    expect(result.imageDigest).toBe(`node@sha256:${"ab".repeat(32)}`);
    expect(result.plan?.manager.spec).toBe("pnpm@10.14.0");
    expect(result.inspection?.commit).toBe(commit);
    expect(docker.stages()).toEqual(["init", "clone", "install", "build", "export"]);
    expect(result.stages.map((s) => [s.stage, s.exitCode])).toEqual([
      ["init", 0],
      ["clone", 0],
      ["install", 0],
      ["build", 0],
      ["export", 0],
    ]);
    expect(docker.pulled).toEqual(["node:22-bookworm", "node:20-bookworm"]);
    expect(docker.volumes).toEqual(["releaseproof-abc"]);
    expect(docker.removed).toEqual(["releaseproof-abc"]);
  });

  it("hardens every stage: unprivileged user, one volume, network only where needed", async () => {
    const docker = happyPath();
    await rebuildPackage(source, target, { docker, volumeId: "abc", memory: "2g", pidsLimit: 512 });
    const [init, clone, install, build, exported] = docker.specs;

    expect(init).toMatchObject({
      user: "0:0",
      network: "none",
      image: "node:22-bookworm",
      capAdd: ["CHOWN"],
    });
    expect(clone).toMatchObject({
      user: "1000:1000",
      network: "bridge",
      image: "node:22-bookworm",
    });
    expect(clone?.env).toMatchObject({
      RP_REPOSITORY: "https://github.com/o/r",
      RP_COMMIT: commit,
      RP_WORKFLOW: ".github/workflows/release.yml",
    });
    expect(clone?.env.RP_INSPECT_JS).toContain("ls-files");
    expect(install).toMatchObject({
      user: "1000:1000",
      network: "bridge",
      image: "node:20-bookworm",
    });
    expect(build).toMatchObject({ user: "1000:1000", network: "none", image: "node:20-bookworm" });
    expect(exported).toMatchObject({
      network: "none",
      volumeReadOnly: true,
      argv: ["cat", "/work/out/package.tgz"],
    });
    for (const spec of docker.specs) {
      // Only the init stage gets a capability back, and only CHOWN.
      expect(spec.capAdd ?? []).toEqual(spec.name.endsWith("-init") ? ["CHOWN"] : []);
      expect(spec.volume).toBe("releaseproof-abc");
      expect(spec.memory).toBe("2g");
      expect(spec.pidsLimit).toBe(512);
      expect(spec.workdir).toBe("/work");
    }
  });

  it("pins the floating package manager spec to the installed version for the offline build", async () => {
    const docker = happyPath();
    await rebuildPackage(source, target, { docker, volumeId: "abc" });
    const installScript = docker.specs[2]?.argv[2] ?? "";
    const buildScript = docker.specs[3]?.argv[2] ?? "";
    expect(installScript).toContain("'corepack' 'pnpm@10' 'install'");
    expect(buildScript).toContain("'corepack' 'pnpm@10.14.0'");
    expect(buildScript).not.toMatch(/'pnpm@10' /);
  });

  it("fails closed when the clone stage fails, without running later stages", async () => {
    const docker = happyPath({
      clone: () => ({ exitCode: 128, stderr: "fatal: could not read from remote" }),
    });
    const result = await rebuildPackage(source, target, { docker, volumeId: "abc" });
    expect(result).toMatchObject({ status: "failed", failure: "clone stage exited with code 128" });
    expect(result.stages[1]?.output).toContain("could not read from remote");
    expect(docker.stages()).toEqual(["init", "clone"]);
    expect(docker.removed).toEqual(["releaseproof-abc"]);
  });

  it("fails when the checkout is not the expected commit or the inspection is unreadable", async () => {
    const other = { ...inspection, commit: "0".repeat(40) };
    const wrongCommit = happyPath({
      clone: () => ({ stdout: Buffer.from(`${INSPECTION_MARKER}\n${JSON.stringify(other)}`) }),
    });
    expect((await rebuildPackage(source, target, { docker: wrongCommit })).failure).toBe(
      `checked out ${"0".repeat(40)} but expected ${commit}`,
    );
    const noMarker = happyPath({ clone: () => ({ stdout: Buffer.from("nothing here") }) });
    expect((await rebuildPackage(source, target, { docker: noMarker })).failure).toMatch(
      /could not read the repository inspection/,
    );
  });

  it("fails with the planner's reason when the package is not in the repository", async () => {
    const docker = happyPath();
    const result = await rebuildPackage(source, { name: "missing", version: "1.0.0" }, { docker });
    expect(result.failure).toBe("package missing was not found in the repository at this commit");
    expect(docker.stages()).toEqual(["init", "clone"]);
  });

  it("reports a timed-out build and a digest mismatch on export", async () => {
    const timedOut = happyPath({ build: () => ({ exitCode: null, timedOut: true }) });
    expect((await rebuildPackage(source, target, { docker: timedOut })).failure).toBe(
      "build stage timed out",
    );

    const tampered = happyPath({ export: () => ({ stdout: Buffer.from("different bytes") }) });
    const result = await rebuildPackage(source, target, { docker: tampered });
    expect(result.status).toBe("failed");
    expect(result.failure).toMatch(/exported tarball digest .* does not match/);
    expect(result.tarball).toBeUndefined();
  });

  it("keeps the volume only when asked", async () => {
    const docker = happyPath();
    await rebuildPackage(source, target, { docker, keepVolume: true });
    expect(docker.removed).toEqual([]);
  });

  it("propagates Docker being unavailable as a ToolError", async () => {
    const docker = happyPath();
    docker.serverVersion = async () => {
      throw new ToolError("Docker is not available");
    };
    await expect(rebuildPackage(source, target, { docker })).rejects.toThrow(ToolError);
  });
});

describe("pinManagerVersion", () => {
  const plan: BuildPlan = {
    packageDir: ".",
    packageName: "tiny",
    packageVersion: "1.0.0",
    manager: { name: "pnpm", spec: "pnpm@10", source: "lockfile" },
    nodeMajor: 22,
    nodeSource: "default",
    image: "node:22-bookworm",
    install: { argv: ["corepack", "pnpm@10", "install"], cwd: "/work/repo" },
    rebuildDeps: { argv: ["corepack", "pnpm@10", "-r", "rebuild"], cwd: "/work/repo" },
    build: {
      argv: ["corepack", "pnpm@10", "--filter", "pnpm@10", "run", "build"],
      cwd: "/work/repo",
    },
    buildSource: "x",
    pack: { argv: ["corepack", "pnpm@10", "pack"], cwd: "/work/repo" },
    packDir: "/work/repo",
    warnings: [],
  };

  it("replaces only the spec token, and leaves exact specs alone", () => {
    const pinned = pinManagerVersion(plan, "10.14.0");
    expect(pinned.manager.spec).toBe("pnpm@10.14.0");
    expect(pinned.build?.argv).toEqual([
      "corepack",
      "pnpm@10.14.0",
      "--filter",
      "pnpm@10",
      "run",
      "build",
    ]);
    expect(pinned.pack.argv[1]).toBe("pnpm@10.14.0");
    expect(pinManagerVersion(plan, undefined)).toBe(plan);
    const exact = { ...plan, manager: { ...plan.manager, spec: "pnpm@10.4.1" } };
    expect(pinManagerVersion(exact, "10.4.1")).toBe(exact);
  });
});

describe("rebuildPackage without an install stage", () => {
  it("goes clone → build → export and takes the tool version from the build stage", async () => {
    const npmInspection = {
      ...inspection,
      lockfiles: ["package-lock.json"],
      lockfileDetails: { npm: 3 },
      packages: [{ dir: ".", name: "tiny", version: "1.0.0", scripts: { test: "tap" } }],
    };
    const docker = happyPath({
      clone: () => ({
        stdout: Buffer.from(`${INSPECTION_MARKER}\n${JSON.stringify(npmInspection)}`),
      }),
      build: () => ({
        stdout: Buffer.from(`${TOOL_VERSION_MARKER} 10.9.9\n${tarballSha}  package.tgz\n`),
      }),
    });
    const result = await rebuildPackage(source, target, { docker, volumeId: "abc" });
    expect(result.status).toBe("ok");
    expect(docker.stages()).toEqual(["init", "clone", "build", "export"]);
    expect(result.plan?.installSkipped).toMatch(/npm pack needs no node_modules/);
    expect(result.toolVersion).toBe("npm 10.9.9");
  });
});
