import { describe, expect, it } from "vitest";
import { ToolError } from "../errors.js";
import type { PackageInfo, RepoInspection } from "./inspect.js";
import { OUT_DIR, parseNodeMajor, planBuild, REPO_DIR } from "./plan.js";

const commit = "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a";

function inspection(overrides: Partial<RepoInspection> = {}): RepoInspection {
  return {
    commit,
    lockfiles: [],
    lockfileDetails: {},
    nodeVersionFiles: {},
    hasYarnrcYml: false,
    hasPnpmWorkspace: false,
    hasLernaJson: false,
    hasSubmodules: false,
    packages: [],
    workflow: null,
    ...overrides,
  };
}

const single: PackageInfo = {
  dir: ".",
  name: "tiny",
  version: "1.0.0",
  scripts: { build: "tsc" },
};

function plan(insp: RepoInspection, target = { name: "tiny", version: "1.0.0" }, overrides = {}) {
  const result = planBuild({ inspection: insp, target, overrides });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.plan;
}

describe("planBuild: image override", () => {
  it.each([
    "node",
    "node:22-bookworm",
    "team/node:Tag_22",
    `node:${"x".repeat(128)}`,
    "registry.example.com:5000/team/node:22",
    "localhost:5000/team/nested/node:22",
    "ghcr.io/team/node",
    "team/node-alpine_22.1",
    `node@sha256:${"ab".repeat(32)}`,
    `node:22@sha256:${"ab".repeat(32)}`,
    `registry.example.com:5000/team/node:22@sha256:${"ab".repeat(32)}`,
  ])("keeps the valid image reference %j", (image) => {
    expect(plan(inspection({ packages: [single] }), undefined, { image }).image).toBe(image);
  });

  it.each([
    "",
    "--privileged",
    "-v",
    ":22",
    "node:",
    `node:${"x".repeat(129)}`,
    "node:22@sha256:",
    "registry.example.com:5000/",
    "node:22 --privileged",
    " node:22",
    "node:22 ",
    "node:22\n",
    "node:22\r",
    "node:22\t",
    "node\0",
    "node\x7f",
    "team//node",
    "node:22;echo",
    "node@",
    `node@sha256:${"a".repeat(63)}`,
    `node@sha256:${"a".repeat(65)}`,
    `node@sha256:${"g".repeat(64)}`,
  ])("rejects malformed image reference %j as a tool error", (image) => {
    expect(() => plan(inspection({ packages: [single] }), undefined, { image })).toThrow(
      new ToolError(
        `--image must be a Docker image reference such as node:22-bookworm, got ${JSON.stringify(image)}`,
      ),
    );
  });
});

describe("planBuild: package selection", () => {
  it("fails when the package is not in the repository", () => {
    expect(
      planBuild({
        inspection: inspection({ packages: [single] }),
        target: { name: "other", version: "1.0.0" },
      }),
    ).toEqual({
      ok: false,
      reason: "package other was not found in the repository at this commit",
    });
  });

  it("prefers the directory whose version matches, and fails on ambiguity", () => {
    const packages: PackageInfo[] = [
      { dir: "packages/a", name: "dup", version: "1.0.0" },
      { dir: "packages/b", name: "dup", version: "2.0.0" },
    ];
    expect(plan(inspection({ packages }), { name: "dup", version: "2.0.0" }).packageDir).toBe(
      "packages/b",
    );
    expect(
      planBuild({
        inspection: inspection({ packages }),
        target: { name: "dup", version: "3.0.0" },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("several package.json files are named dup"),
    });
  });

  it("refuses private packages and warns on a version mismatch", () => {
    expect(
      planBuild({
        inspection: inspection({ packages: [{ ...single, private: true }] }),
        target: { name: "tiny", version: "1.0.0" },
      }),
    ).toEqual({
      ok: false,
      reason: "tiny at . is marked private",
    });
    const result = plan(inspection({ packages: [single] }), { name: "tiny", version: "1.0.1" });
    expect(result.warnings).toContain(
      "repository has version 1.0.0 at this commit, the release is 1.0.1",
    );
  });
});

describe("planBuild: package manager and commands", () => {
  it("npm with a lockfile: ci, rebuild, build, pack", () => {
    const result = plan(
      inspection({
        packages: [single],
        lockfiles: ["package-lock.json"],
        lockfileDetails: { npm: 3 },
      }),
    );
    expect(result.manager).toEqual({ name: "npm", spec: undefined, source: "package-lock.json" });
    expect(result.install).toEqual({ argv: ["npm", "ci", "--ignore-scripts"], cwd: REPO_DIR });
    expect(result.rebuildDeps).toEqual({ argv: ["npm", "rebuild"], cwd: REPO_DIR });
    expect(result.build).toEqual({ argv: ["npm", "run", "build"], cwd: REPO_DIR });
    expect(result.pack).toEqual({
      argv: ["npm", "pack", "--pack-destination", OUT_DIR],
      cwd: REPO_DIR,
    });
    expect(result.warnings).toEqual([]);
  });

  it("npm without any lockfile installs with a warning", () => {
    const result = plan(inspection({ packages: [single] }));
    expect(result.install?.argv).toEqual(["npm", "install", "--ignore-scripts"]);
    expect(result.warnings).toEqual([
      "no lockfile found: dependency versions are not pinned, so the rebuild may drift",
    ]);
  });

  it("pnpm monorepo via packageManager: filtered build, pack in the package dir", () => {
    const root: PackageInfo = {
      dir: ".",
      name: "monorepo",
      private: true,
      packageManager: "pnpm@10.4.1+sha512.abc",
      scripts: { build: "turbo build" },
    };
    const pkg: PackageInfo = {
      dir: "packages/core",
      name: "@scope/core",
      version: "2.0.0",
      scripts: { build: "tsup" },
    };
    const result = plan(
      inspection({
        packages: [root, pkg],
        lockfiles: ["pnpm-lock.yaml"],
        lockfileDetails: { pnpm: "9.0" },
        hasPnpmWorkspace: true,
      }),
      { name: "@scope/core", version: "2.0.0" },
    );
    expect(result.manager).toEqual({
      name: "pnpm",
      spec: "pnpm@10.4.1",
      source: "packageManager field",
    });
    expect(result.install).toEqual({
      argv: ["corepack", "pnpm@10.4.1", "install", "--frozen-lockfile", "--ignore-scripts"],
      cwd: REPO_DIR,
    });
    expect(result.rebuildDeps).toEqual({
      argv: ["corepack", "pnpm@10.4.1", "-r", "rebuild"],
      cwd: REPO_DIR,
    });
    expect(result.build).toEqual({
      argv: ["corepack", "pnpm@10.4.1", "--filter", "@scope/core...", "run", "build"],
      cwd: REPO_DIR,
    });
    expect(result.pack).toEqual({
      argv: ["corepack", "pnpm@10.4.1", "pack", "--pack-destination", OUT_DIR],
      cwd: `${REPO_DIR}/packages/core`,
    });
  });

  it("pnpm from the lockfile version when there is no packageManager field", () => {
    expect(
      plan(
        inspection({
          packages: [single],
          lockfiles: ["pnpm-lock.yaml"],
          lockfileDetails: { pnpm: "6.0" },
        }),
      ).manager,
    ).toEqual({
      name: "pnpm",
      spec: "pnpm@8",
      source: "pnpm-lock.yaml (lockfileVersion 6.0)",
    });
  });

  it("Yarn Berry monorepo: immutable install without builds, recursive workspace build", () => {
    const root: PackageInfo = {
      dir: ".",
      name: "root",
      private: true,
      hasWorkspaces: true,
      packageManager: "yarn@4.6.0",
    };
    const pkg: PackageInfo = {
      dir: "packages/x",
      name: "x",
      version: "1.0.0",
      scripts: { build: "tsc" },
    };
    const result = plan(
      inspection({
        packages: [root, pkg],
        lockfiles: ["yarn.lock"],
        lockfileDetails: { yarnBerry: true },
        hasYarnrcYml: true,
      }),
      { name: "x", version: "1.0.0" },
    );
    expect(result.manager.name).toBe("yarn-berry");
    expect(result.install?.argv).toEqual([
      "corepack",
      "yarn@4.6.0",
      "install",
      "--immutable",
      "--mode=skip-build",
    ]);
    expect(result.rebuildDeps?.argv).toEqual(["corepack", "yarn@4.6.0", "rebuild"]);
    expect(result.build?.argv).toEqual([
      "corepack",
      "yarn@4.6.0",
      "workspaces",
      "foreach",
      "-Rt",
      "--from",
      "x",
      "run",
      "build",
    ]);
    expect(result.pack).toEqual({
      argv: ["corepack", "yarn@4.6.0", "pack", "--out", `${OUT_DIR}/package.tgz`],
      cwd: `${REPO_DIR}/packages/x`,
    });
  });

  it("Yarn classic: frozen lockfile, no rebuild step", () => {
    const result = plan(
      inspection({
        packages: [single],
        lockfiles: ["yarn.lock"],
        lockfileDetails: { yarnBerry: false },
      }),
    );
    expect(result.manager).toEqual({
      name: "yarn-classic",
      spec: "yarn@1",
      source: "yarn.lock (classic format)",
    });
    expect(result.install?.argv).toEqual([
      "corepack",
      "yarn@1",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    expect(result.rebuildDeps).toBeUndefined();
    expect(result.pack.argv).toEqual([
      "corepack",
      "yarn@1",
      "pack",
      "--filename",
      `${OUT_DIR}/package.tgz`,
    ]);
  });

  it("npm workspaces: root build script runs from the root", () => {
    const root: PackageInfo = {
      dir: ".",
      name: "root",
      private: true,
      hasWorkspaces: true,
      scripts: { build: "npm run build --workspaces" },
    };
    const pkg: PackageInfo = {
      dir: "packages/x",
      name: "x",
      version: "1.0.0",
      scripts: { build: "tsc" },
    };
    const result = plan(inspection({ packages: [root, pkg], lockfiles: ["package-lock.json"] }), {
      name: "x",
      version: "1.0.0",
    });
    expect(result.build).toEqual({ argv: ["npm", "run", "build"], cwd: REPO_DIR });
    expect(result.buildSource).toBe('"build" script of packages/x (run from the root)');
  });

  it("falls back to the root build script, or to no build at all", () => {
    const root: PackageInfo = {
      dir: ".",
      name: "root",
      private: true,
      hasWorkspaces: true,
      scripts: { build: "make" },
    };
    const pkg: PackageInfo = { dir: "packages/x", name: "x", version: "1.0.0" };
    expect(
      plan(inspection({ packages: [root, pkg] }), { name: "x", version: "1.0.0" }),
    ).toMatchObject({
      build: { argv: ["npm", "run", "build"], cwd: REPO_DIR },
      buildSource: 'root "build" script',
    });
    expect(plan(inspection({ packages: [{ ...single, scripts: {} }] }))).toMatchObject({
      build: undefined,
      buildSource: "no build script; packing the checkout as is",
    });
  });

  it("honours --build-command and publishConfig.directory", () => {
    const pkg: PackageInfo = { ...single, publishConfig: { directory: "dist" } };
    const result = plan(inspection({ packages: [pkg] }), undefined, {
      buildCommand: "make release",
    });
    expect(result.build).toEqual({ argv: ["bash", "-lc", "make release"], cwd: REPO_DIR });
    expect(result.packDir).toBe(`${REPO_DIR}/dist`);
    expect(result.pack.cwd).toBe(`${REPO_DIR}/dist`);
    expect(
      planBuild({
        inspection: inspection({ packages: [{ ...single, publishConfig: { directory: "../x" } }] }),
        target: { name: "tiny", version: "1.0.0" },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects bun lockfiles for now", () => {
    expect(
      planBuild({
        inspection: inspection({ packages: [single], lockfiles: ["bun.lock"] }),
        target: { name: "tiny", version: "1.0.0" },
      }),
    ).toEqual({
      ok: false,
      reason: "bun lockfiles are not supported yet",
    });
  });
});

describe("planBuild: Node version", () => {
  it("prefers the release workflow's setup-node version", () => {
    const workflow =
      "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: '20.x'\n";
    const result = plan(
      inspection({ packages: [single], workflow, nodeVersionFiles: { ".nvmrc": "18" } }),
    );
    expect(result).toMatchObject({
      nodeMajor: 20,
      nodeSource: 'workflow node-version "20.x"',
      image: "node:20-bookworm",
    });
  });

  it("follows node-version-file to the file it names", () => {
    const workflow = "      node-version-file: .nvmrc\n";
    expect(
      plan(
        inspection({ packages: [single], workflow, nodeVersionFiles: { ".nvmrc": "v22.14.0\n" } }),
      ),
    ).toMatchObject({
      nodeMajor: 22,
      nodeSource: "workflow node-version-file .nvmrc",
    });
  });

  it("skips unresolvable matrix expressions and lts/* gets an explicit assumption", () => {
    const matrix = `node-version: \${{ matrix.node }}\n`;
    expect(
      plan(
        inspection({
          packages: [single],
          workflow: matrix,
          nodeVersionFiles: { ".node-version": "20" },
        }),
      ).nodeSource,
    ).toBe(".node-version");
    expect(
      plan(inspection({ packages: [single], workflow: "node-version: lts/*\n" })),
    ).toMatchObject({
      nodeMajor: 24,
      nodeSource: 'workflow node-version "lts/*" (assumed 24; use --node to override)',
    });
  });

  it("falls back to .nvmrc, .tool-versions, engines.node, then 22", () => {
    expect(
      plan(inspection({ packages: [single], nodeVersionFiles: { ".nvmrc": "lts/iron" } }))
        .nodeMajor,
    ).toBe(20);
    expect(
      plan(
        inspection({
          packages: [single],
          nodeVersionFiles: { ".tool-versions": "python 3.12\nnodejs 18.20.4\n" },
        }),
      ).nodeMajor,
    ).toBe(18);
    expect(
      plan(inspection({ packages: [{ ...single, engines: { node: "^20.0.0 || >=22" } }] })),
    ).toMatchObject({
      nodeMajor: 20,
      nodeSource: 'engines.node "^20.0.0 || >=22"',
    });
    expect(plan(inspection({ packages: [single] }))).toMatchObject({
      nodeMajor: 22,
      nodeSource: "default",
    });
  });

  it("lets --node and --image override everything", () => {
    expect(
      plan(inspection({ packages: [single], workflow: "node-version: 20\n" }), undefined, {
        nodeMajor: 24,
        image: "node:24-alpine",
      }),
    ).toMatchObject({
      nodeMajor: 24,
      nodeSource: "--node option",
      image: "node:24-alpine",
    });
  });
});

describe("parseNodeMajor", () => {
  it.each([
    ["22", 22],
    ["v22.14.0", 22],
    ["20.x", 20],
    ["lts/jod", 22],
    [">=18.17.0", 18],
    ["^20.0.0 || >=22", 20],
    ["18 || 20 || 22", 18],
    ["", undefined],
    ["latest", undefined],
  ])("parses %j as %s", (text, expected) => {
    expect(parseNodeMajor(text)).toBe(expected);
  });
});

describe("planBuild: skipping the install stage", () => {
  it("skips install for an npm package with no build step and no pack-time scripts", () => {
    const result = plan(
      inspection({
        packages: [{ ...single, scripts: { test: "tap" } }],
        lockfiles: ["package-lock.json"],
      }),
    );
    expect(result.install).toBeUndefined();
    expect(result.rebuildDeps).toBeUndefined();
    expect(result.installSkipped).toBe(
      "no build step and no pack-time scripts, so npm pack needs no node_modules",
    );
    expect(result.pack.argv).toEqual(["npm", "pack", "--pack-destination", OUT_DIR]);
  });

  it("keeps the install stage when a pack-time script, a build, publishConfig.directory or another manager is involved", () => {
    expect(
      plan(inspection({ packages: [{ ...single, scripts: { prepare: "husky" } }] })).install,
    ).toBeDefined();
    expect(plan(inspection({ packages: [single] })).install).toBeDefined();
    expect(
      plan(
        inspection({
          packages: [{ ...single, scripts: {}, publishConfig: { directory: "dist" } }],
        }),
      ).install,
    ).toBeDefined();
    expect(
      plan(inspection({ packages: [{ ...single, scripts: {} }], lockfiles: ["pnpm-lock.yaml"] }))
        .install,
    ).toBeDefined();
  });
});

describe("planBuild: pnpm root packages and released versions", () => {
  it("builds a root pnpm package with a plain run, since --filter never matches the workspace root", () => {
    const result = plan(
      inspection({
        packages: [{ ...single, packageManager: "pnpm@10.9.0" }],
        lockfiles: ["pnpm-lock.yaml"],
        lockfileDetails: { pnpm: "9.0" },
      }),
    );
    expect(result.build).toEqual({
      argv: ["corepack", "pnpm@10.9.0", "run", "build"],
      cwd: REPO_DIR,
    });
  });

  it("applies the released version before packing when the commit carries another one", () => {
    const placeholder = { ...single, version: "0.0.0-semantic-release" };
    expect(
      plan(inspection({ packages: [placeholder] }), { name: "tiny", version: "4.23.15" })
        .setVersion,
    ).toBe("4.23.15");
    expect(plan(inspection({ packages: [single] })).setVersion).toBeUndefined();
  });
});

describe("planBuild: Lerna repositories without npm workspaces", () => {
  const root: PackageInfo = {
    dir: ".",
    name: "root",
    private: true,
    scripts: { build: "lerna run tsc" },
  };
  const core: PackageInfo = {
    dir: "packages/core",
    name: "@actions/core",
    version: "3.0.1",
    scripts: { tsc: "tsc -p tsconfig.json" },
    lockfiles: ["package-lock.json"],
  };
  const lerna = inspection({
    packages: [root, core],
    lockfiles: ["package-lock.json"],
    hasLernaJson: true,
  });

  it("treats lerna.json as a workspace, installs the package itself, and runs the script the root lerna build names", () => {
    const result = plan(lerna, { name: "@actions/core", version: "3.0.1" });
    expect(result.install).toEqual({ argv: ["npm", "ci", "--ignore-scripts"], cwd: REPO_DIR });
    expect(result.installExtra).toEqual({
      argv: ["npm", "ci", "--ignore-scripts"],
      cwd: `${REPO_DIR}/packages/core`,
    });
    expect(result.build).toEqual({ argv: ["npm", "run", "tsc"], cwd: `${REPO_DIR}/packages/core` });
    expect(result.buildSource).toBe(
      '"tsc" script of packages/core (named by the root lerna build)',
    );
  });

  it("falls back to the root build when the package lacks the named script, and never adds a second install with npm workspaces", () => {
    const other = { ...core, scripts: {} };
    expect(
      plan(inspection({ ...lerna, packages: [root, other] }), {
        name: "@actions/core",
        version: "3.0.1",
      }),
    ).toMatchObject({
      build: { argv: ["npm", "run", "build"], cwd: REPO_DIR },
      buildSource: 'root "build" script',
    });
    const withWorkspaces = inspection({
      ...lerna,
      packages: [{ ...root, hasWorkspaces: true }, core],
    });
    expect(
      plan(withWorkspaces, { name: "@actions/core", version: "3.0.1" }).installExtra,
    ).toBeUndefined();
  });
});

describe("planBuild: unknown package managers", () => {
  it("refuses a packageManager field it cannot run instead of guessing another tool", () => {
    const result = planBuild({
      inspection: inspection({
        packages: [{ ...single, packageManager: "nub@0.8.3" }],
        lockfiles: ["pnpm-lock.yaml"],
      }),
      target: { name: "tiny", version: "1.0.0" },
    });
    expect(result).toEqual({
      ok: false,
      reason: 'package manager "nub@0.8.3" is not supported (only npm, pnpm and yarn are)',
    });
  });
});
