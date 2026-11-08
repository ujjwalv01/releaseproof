import { ToolError } from "../errors.js";
import type { PackageInfo, RepoInspection } from "./inspect.js";

export const WORK_DIR = "/work";
export const REPO_DIR = "/work/repo";
export const OUT_DIR = "/work/out";
export const DEFAULT_NODE_MAJOR = 22;

const IMAGE_PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const IMAGE_REFERENCE_RE = new RegExp(
  `^(?:[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?/)?${IMAGE_PATH_COMPONENT}(?:/${IMAGE_PATH_COMPONENT})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?$`,
);

/** Common Docker names, optional registry port/tag and SHA-256 digest; never Docker flags. */
export function validateImageReference(image: string, inputName = "--image"): string {
  // `$` also matches before a final newline in JavaScript, so reject whitespace separately.
  if (/\s/.test(image) || !IMAGE_REFERENCE_RE.test(image)) {
    throw new ToolError(
      `${inputName} must be a Docker image reference such as node:22-bookworm, got ${JSON.stringify(image)}`,
    );
  }
  return image;
}

export type PackageManagerName = "npm" | "pnpm" | "yarn-berry" | "yarn-classic";

/** Scripts npm runs during `npm pack`; their presence means the install stage is needed. */
export const PACK_TIME_SCRIPTS = [
  "prepack",
  "prepare",
  "prepublishOnly",
  "postpack",
  "preprepare",
  "postprepare",
  "prepublish",
] as const;

export interface PackageManager {
  name: PackageManagerName;
  /** Corepack spec such as `pnpm@10.4.1` or `yarn@1`; undefined for the image's npm. */
  spec: string | undefined;
  /** Where the choice came from, for the report. */
  source: string;
}

/** One command to run inside the container: argv (never a shell string) and its directory. */
export interface Command {
  argv: string[];
  cwd: string;
}

export interface BuildPlan {
  packageDir: string;
  packageName: string;
  packageVersion: string | undefined;
  manager: PackageManager;
  nodeMajor: number;
  nodeSource: string;
  image: string;
  /** Undefined when nothing needs node_modules; `installSkipped` says why. */
  install: Command | undefined;
  installSkipped?: string | undefined;
  /** A second install in the package directory, for Lerna repos without workspaces. */
  installExtra?: Command | undefined;
  /**
   * The released version, applied to package.json before packing when the commit carries a
   * different one (release tooling such as semantic-release sets it at publish time).
   */
  setVersion?: string | undefined;
  /** Runs dependency lifecycle scripts offline. Failure is logged, not fatal. */
  rebuildDeps: Command | undefined;
  build: Command | undefined;
  buildSource: string;
  pack: Command;
  /** Directory that gets packed: the package dir or `publishConfig.directory`. */
  packDir: string;
  warnings: string[];
}

export interface PlanOverrides {
  image?: string | undefined;
  nodeMajor?: number | undefined;
  /** Replaces the detected build command; run in the package directory with the image's shell. */
  buildCommand?: string | undefined;
}

export interface PlanInput {
  inspection: RepoInspection;
  target: { name: string; version: string };
  overrides?: PlanOverrides | undefined;
}

export type PlanResult = { ok: true; plan: BuildPlan } | { ok: false; reason: string };

const NODE_CODENAMES: Record<string, number> = {
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

/** "22", "v22.14.0", "22.x", "lts/jod", ">=20.0.0 || ^22" → a major, or undefined. */
export function parseNodeMajor(text: string): number | undefined {
  const value = text.trim().toLowerCase();
  const codename = /^lts\/([a-z]+)$/.exec(value)?.[1];
  if (codename) {
    return NODE_CODENAMES[codename];
  }
  // Ranges: take the lowest major mentioned, which is what the build must support.
  const majors = [...value.matchAll(/(?:^|[^0-9.])v?(\d{1,2})(?:\.(?:\d+|x|\*))?/g)]
    .map((match) => Number(match[1]))
    .filter((major) => major >= 10 && major <= 40);
  return majors.length > 0 ? Math.min(...majors) : undefined;
}

function nodeFromWorkflow(
  workflow: string,
  files: Record<string, string>,
): { major: number; source: string } | undefined {
  const file = /node-version-file:\s*['"]?([^'"\s]+)/.exec(workflow)?.[1];
  if (file) {
    const name = file.replace(/^\.\//, "");
    const contents = files[name];
    const major = contents ? parseNodeMajor(contents) : undefined;
    if (major !== undefined) {
      return { major, source: `workflow node-version-file ${name}` };
    }
  }
  const raw = /node-version:\s*['"]?([^'"\n]+)/.exec(workflow)?.[1]?.trim();
  if (!raw || raw.includes("${{")) {
    return undefined;
  }
  if (/^(lts\/\*|latest|current|node)$/.test(raw)) {
    return {
      major: 24,
      source: `workflow node-version "${raw}" (assumed 24; use --node to override)`,
    };
  }
  const major = parseNodeMajor(raw);
  return major === undefined ? undefined : { major, source: `workflow node-version "${raw}"` };
}

function chooseNode(
  inspection: RepoInspection,
  pkg: PackageInfo,
  root: PackageInfo | undefined,
  overrides: PlanOverrides,
): { major: number; source: string } {
  if (overrides.nodeMajor !== undefined) {
    return { major: overrides.nodeMajor, source: "--node option" };
  }
  if (inspection.workflow) {
    const fromWorkflow = nodeFromWorkflow(inspection.workflow, inspection.nodeVersionFiles);
    if (fromWorkflow) {
      return fromWorkflow;
    }
  }
  for (const name of [".nvmrc", ".node-version"]) {
    const contents = inspection.nodeVersionFiles[name];
    const major = contents ? parseNodeMajor(contents) : undefined;
    if (major !== undefined) {
      return { major, source: name };
    }
  }
  const tool = inspection.nodeVersionFiles[".tool-versions"];
  const toolLine = tool ? /^nodejs\s+(\S+)/m.exec(tool)?.[1] : undefined;
  const toolMajor = toolLine ? parseNodeMajor(toolLine) : undefined;
  if (toolMajor !== undefined) {
    return { major: toolMajor, source: ".tool-versions" };
  }
  for (const [info, label] of [
    [pkg, "engines.node"],
    [root, "root engines.node"],
  ] as const) {
    const range = info?.engines?.node;
    const major = range ? parseNodeMajor(range) : undefined;
    if (major !== undefined) {
      return { major, source: `${label} "${range}"` };
    }
  }
  return { major: DEFAULT_NODE_MAJOR, source: "default" };
}

function parsePackageManagerField(field: string): PackageManager | undefined {
  const match = /^(npm|pnpm|yarn)@(\d+)(?:\.[^+\s]*)?(?:\+.*)?$/.exec(field.trim());
  if (!match) {
    return undefined;
  }
  const [, name, major] = match;
  const spec = field.trim().split("+")[0] ?? field.trim();
  if (name === "yarn") {
    return {
      name: Number(major) >= 2 ? "yarn-berry" : "yarn-classic",
      spec,
      source: "packageManager field",
    };
  }
  return { name: name === "pnpm" ? "pnpm" : "npm", spec, source: "packageManager field" };
}

function chooseManager(
  inspection: RepoInspection,
  pkg: PackageInfo,
  root: PackageInfo | undefined,
  warnings: string[],
): PackageManager | { unsupported: string } {
  for (const field of [pkg.packageManager, root?.packageManager]) {
    if (field) {
      const parsed = parsePackageManagerField(field);
      if (parsed) {
        return parsed;
      }
      // Guessing another tool here fails later in confusing ways (zod uses "nub"); say so.
      return {
        unsupported: `package manager "${field}" is not supported (only npm, pnpm and yarn are)`,
      };
    }
  }
  const lock = new Set(inspection.lockfiles);
  if (lock.has("bun.lock") || lock.has("bun.lockb")) {
    return { unsupported: "bun lockfiles are not supported yet" };
  }
  if (lock.has("pnpm-lock.yaml")) {
    const version = inspection.lockfileDetails.pnpm;
    const spec = version === "5.4" ? "pnpm@7" : version === "6.0" ? "pnpm@8" : "pnpm@10";
    return { name: "pnpm", spec, source: `pnpm-lock.yaml (lockfileVersion ${version ?? "?"})` };
  }
  if (lock.has("yarn.lock")) {
    const berry = inspection.lockfileDetails.yarnBerry || inspection.hasYarnrcYml;
    return berry
      ? { name: "yarn-berry", spec: "yarn@4", source: "yarn.lock (Berry format)" }
      : { name: "yarn-classic", spec: "yarn@1", source: "yarn.lock (classic format)" };
  }
  if (lock.has("package-lock.json") || lock.has("npm-shrinkwrap.json")) {
    return { name: "npm", spec: undefined, source: "package-lock.json" };
  }
  warnings.push("no lockfile found: dependency versions are not pinned, so the rebuild may drift");
  return { name: "npm", spec: undefined, source: "default (no lockfile)" };
}

function managerArgv(manager: PackageManager, ...args: string[]): string[] {
  const binary = manager.name === "npm" ? "npm" : "yarn";
  const tool = manager.name === "pnpm" ? "pnpm" : binary;
  return manager.spec ? ["corepack", manager.spec, ...args] : [tool, ...args];
}

/** Decides exactly what the container will run. Pure: same inspection, same plan. */
export function planBuild(input: PlanInput): PlanResult {
  const { inspection, target } = input;
  const overrides = input.overrides ?? {};
  if (overrides.image !== undefined) validateImageReference(overrides.image);
  const warnings: string[] = [];

  const candidates = inspection.packages.filter((pkg) => pkg.name === target.name);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `package ${target.name} was not found in the repository at this commit`,
    };
  }
  const pkg =
    candidates.find((candidate) => candidate.version === target.version) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!pkg) {
    const dirs = candidates.map((candidate) => candidate.dir).join(", ");
    return {
      ok: false,
      reason: `several package.json files are named ${target.name} (${dirs}) and none has version ${target.version}`,
    };
  }
  if (pkg.private) {
    return { ok: false, reason: `${target.name} at ${pkg.dir} is marked private` };
  }
  if (pkg.version !== target.version) {
    warnings.push(
      `repository has version ${pkg.version ?? "(none)"} at this commit, the release is ${target.version}`,
    );
  }

  const root = inspection.packages.find((candidate) => candidate.dir === ".");
  const manager = chooseManager(inspection, pkg, root, warnings);
  if ("unsupported" in manager) {
    return { ok: false, reason: manager.unsupported };
  }
  if (inspection.hasSubmodules) {
    warnings.push("repository uses git submodules; they are cloned at their recorded commits");
  }

  const node = chooseNode(inspection, pkg, root, overrides);
  const image = overrides.image ?? `node:${node.major}-bookworm`;
  const rootDir = root ? REPO_DIR : `${REPO_DIR}/${pkg.dir}`;
  const pkgDir = pkg.dir === "." ? REPO_DIR : `${REPO_DIR}/${pkg.dir}`;
  const isWorkspace =
    Boolean(root?.hasWorkspaces || inspection.hasPnpmWorkspace || inspection.hasLernaJson) &&
    pkg.dir !== ".";

  let install: Command | undefined;
  let rebuildDeps: Command | undefined;
  let pack: Command;
  switch (manager.name) {
    case "pnpm":
      install = {
        argv: managerArgv(manager, "install", "--frozen-lockfile", "--ignore-scripts"),
        cwd: rootDir,
      };
      rebuildDeps = { argv: managerArgv(manager, "-r", "rebuild"), cwd: rootDir };
      pack = { argv: managerArgv(manager, "pack", "--pack-destination", OUT_DIR), cwd: pkgDir };
      break;
    case "yarn-berry":
      install = {
        argv: managerArgv(manager, "install", "--immutable", "--mode=skip-build"),
        cwd: rootDir,
      };
      rebuildDeps = { argv: managerArgv(manager, "rebuild"), cwd: rootDir };
      pack = { argv: managerArgv(manager, "pack", "--out", `${OUT_DIR}/package.tgz`), cwd: pkgDir };
      break;
    case "yarn-classic":
      install = {
        argv: managerArgv(manager, "install", "--frozen-lockfile", "--ignore-scripts"),
        cwd: rootDir,
      };
      rebuildDeps = undefined;
      pack = {
        argv: managerArgv(manager, "pack", "--filename", `${OUT_DIR}/package.tgz`),
        cwd: pkgDir,
      };
      break;
    default: {
      const hasLock = inspection.lockfiles.some(
        (name) => name === "package-lock.json" || name === "npm-shrinkwrap.json",
      );
      install = {
        argv: managerArgv(manager, hasLock ? "ci" : "install", "--ignore-scripts"),
        cwd: rootDir,
      };
      rebuildDeps = { argv: managerArgv(manager, "rebuild"), cwd: rootDir };
      pack = { argv: managerArgv(manager, "pack", "--pack-destination", OUT_DIR), cwd: pkgDir };
    }
  }

  // Lerna repos without npm workspaces (actions/toolkit) install each package on its own.
  let installExtra: Command | undefined;
  if (manager.name === "npm" && isWorkspace && !root?.hasWorkspaces && pkgDir !== rootDir) {
    const hasPackageLock = (pkg.lockfiles ?? []).some(
      (name) => name === "package-lock.json" || name === "npm-shrinkwrap.json",
    );
    installExtra = {
      argv: managerArgv(manager, hasPackageLock ? "ci" : "install", "--ignore-scripts"),
      cwd: pkgDir,
    };
  }

  let build: Command | undefined;
  let buildSource: string;
  if (overrides.buildCommand) {
    build = { argv: ["bash", "-lc", overrides.buildCommand], cwd: pkgDir };
    buildSource = "--build-command option";
  } else if (pkg.scripts?.build) {
    switch (manager.name) {
      case "pnpm":
        // --filter selects workspace projects; the workspace root itself is not one.
        build = isWorkspace
          ? {
              argv: managerArgv(manager, "--filter", `${target.name}...`, "run", "build"),
              cwd: rootDir,
            }
          : { argv: managerArgv(manager, "run", "build"), cwd: pkgDir };
        break;
      case "yarn-berry":
        build = isWorkspace
          ? {
              argv: managerArgv(
                manager,
                "workspaces",
                "foreach",
                "-Rt",
                "--from",
                target.name,
                "run",
                "build",
              ),
              cwd: rootDir,
            }
          : { argv: managerArgv(manager, "run", "build"), cwd: pkgDir };
        break;
      default:
        build =
          isWorkspace && root?.scripts?.build
            ? { argv: managerArgv(manager, "run", "build"), cwd: rootDir }
            : { argv: managerArgv(manager, "run", "build"), cwd: pkgDir };
    }
    buildSource = `"build" script of ${pkg.dir === "." ? "the package" : pkg.dir}${build.cwd === rootDir && pkg.dir !== "." ? " (run from the root)" : ""}`;
  } else if (isWorkspace && root?.scripts?.build) {
    // "lerna run tsc" at the root names the per-package script; run just ours.
    const lernaScript = /^lerna run (\S+)/.exec(root.scripts.build)?.[1];
    if (lernaScript && pkg.scripts?.[lernaScript]) {
      build = { argv: managerArgv(manager, "run", lernaScript), cwd: pkgDir };
      buildSource = `"${lernaScript}" script of ${pkg.dir} (named by the root lerna build)`;
    } else {
      build = { argv: managerArgv(manager, "run", "build"), cwd: rootDir };
      buildSource = 'root "build" script';
    }
  } else {
    build = undefined;
    buildSource = "no build script; packing the checkout as is";
  }

  // `npm pack` only needs node_modules when a script runs at pack time. Skipping the install
  // turns minutes into seconds for plain-JavaScript packages. pnpm and Yarn always install:
  // that stage is where Corepack downloads them for the offline build.
  let installSkipped: string | undefined;
  const packTimeScript = PACK_TIME_SCRIPTS.find((name) => pkg.scripts?.[name] !== undefined);
  if (manager.name === "npm" && !build && !pkg.publishConfig?.directory && !packTimeScript) {
    install = undefined;
    rebuildDeps = undefined;
    installSkipped = "no build step and no pack-time scripts, so npm pack needs no node_modules";
  }

  const publishDirectory = pkg.publishConfig?.directory;
  let packDir = pkgDir;
  if (typeof publishDirectory === "string" && publishDirectory !== "") {
    if (publishDirectory.startsWith("/") || publishDirectory.split("/").includes("..")) {
      return {
        ok: false,
        reason: `publishConfig.directory "${publishDirectory}" escapes the package`,
      };
    }
    packDir = `${pkgDir}/${publishDirectory}`;
    pack = { ...pack, cwd: packDir };
  }

  return {
    ok: true,
    plan: {
      packageDir: pkg.dir,
      packageName: target.name,
      packageVersion: pkg.version,
      manager,
      nodeMajor: node.major,
      nodeSource: node.source,
      image,
      install,
      installSkipped,
      installExtra,
      setVersion: pkg.version === target.version ? undefined : target.version,
      rebuildDeps,
      build,
      buildSource,
      pack,
      packDir,
      warnings,
    },
  };
}
