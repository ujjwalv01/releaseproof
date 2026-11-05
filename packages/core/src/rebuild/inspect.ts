/**
 * What the clone stage reports back about the repository. Produced inside the container
 * by reading files only (no repository code runs); parsed here without trusting it.
 */
export interface PackageInfo {
  /** Directory relative to the repository root, "." for the root package.json. */
  dir: string;
  name?: string | undefined;
  version?: string | undefined;
  private?: boolean | undefined;
  scripts?: Record<string, string> | undefined;
  packageManager?: string | undefined;
  publishConfig?: Record<string, unknown> | undefined;
  engines?: Record<string, string> | undefined;
  hasWorkspaces?: boolean | undefined;
  /** Lockfiles next to this package.json (Lerna-style repos install per package). */
  lockfiles?: string[] | undefined;
}

export interface RepoInspection {
  commit: string;
  /** Names of lockfiles present at the repository root. */
  lockfiles: string[];
  /** pnpm `lockfileVersion`, npm `lockfileVersion`, Yarn `__metadata` presence, when readable. */
  lockfileDetails: {
    pnpm?: string | undefined;
    npm?: number | undefined;
    yarnBerry?: boolean | undefined;
  };
  /** Contents of .nvmrc, .node-version and .tool-versions when present. */
  nodeVersionFiles: Record<string, string>;
  hasYarnrcYml: boolean;
  hasPnpmWorkspace: boolean;
  /** lerna.json at the root: a workspace even without npm `workspaces`. */
  hasLernaJson: boolean;
  hasSubmodules: boolean;
  packages: PackageInfo[];
  /** Text of the release workflow file, when a path was known and the file exists. */
  workflow: string | null;
}

export class InspectionError extends Error {
  override readonly name = "InspectionError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

function parsePackage(value: unknown): PackageInfo {
  if (!isRecord(value) || typeof value.dir !== "string") {
    throw new InspectionError("package entry is malformed");
  }
  if (value.dir.includes("\0")) {
    throw new InspectionError("package directory contains NUL");
  }
  if (value.dir.startsWith("/") || value.dir.split("/").includes("..")) {
    throw new InspectionError(`package directory "${value.dir}" is not inside the repository`);
  }
  const publishConfig = isRecord(value.publishConfig) ? value.publishConfig : undefined;
  if (typeof publishConfig?.directory === "string" && publishConfig.directory.includes("\0")) {
    throw new InspectionError("publishConfig.directory contains NUL");
  }
  return {
    dir: value.dir,
    name: optionalString(value.name),
    version: optionalString(value.version),
    private: typeof value.private === "boolean" ? value.private : undefined,
    scripts: stringRecord(value.scripts),
    packageManager: optionalString(value.packageManager),
    publishConfig,
    engines: stringRecord(value.engines),
    hasWorkspaces: typeof value.hasWorkspaces === "boolean" ? value.hasWorkspaces : undefined,
    lockfiles: Array.isArray(value.lockfiles)
      ? value.lockfiles.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

/** Validates the inspection JSON printed by the clone stage. Throws InspectionError. */
export function parseInspection(json: unknown): RepoInspection {
  if (!isRecord(json)) {
    throw new InspectionError("inspection is not an object");
  }
  if (typeof json.commit !== "string" || !/^[0-9a-f]{40}$/.test(json.commit)) {
    throw new InspectionError("inspection has no commit");
  }
  if (!Array.isArray(json.packages)) {
    throw new InspectionError("inspection has no packages list");
  }
  const details = isRecord(json.lockfileDetails) ? json.lockfileDetails : {};
  return {
    commit: json.commit,
    lockfiles: Array.isArray(json.lockfiles)
      ? json.lockfiles.filter((entry): entry is string => typeof entry === "string")
      : [],
    lockfileDetails: {
      pnpm: optionalString(details.pnpm),
      npm: typeof details.npm === "number" ? details.npm : undefined,
      yarnBerry: typeof details.yarnBerry === "boolean" ? details.yarnBerry : undefined,
    },
    nodeVersionFiles: stringRecord(json.nodeVersionFiles) ?? {},
    hasYarnrcYml: json.hasYarnrcYml === true,
    hasPnpmWorkspace: json.hasPnpmWorkspace === true,
    hasLernaJson: json.hasLernaJson === true,
    hasSubmodules: json.hasSubmodules === true,
    packages: json.packages.map(parsePackage),
    workflow: typeof json.workflow === "string" ? json.workflow : null,
  };
}
