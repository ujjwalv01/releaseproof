import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseMemoryLimit,
  parseNodeMajorOption,
  parseSpec,
  STAGE_ID_RE,
  ToolError,
  validateImageReference,
} from "@releaseproof/core";

export type FailOn = "non-zero" | "differs" | "never";

export interface ActionInputs {
  /** Undefined when a stage id is given without a usable package spec. */
  spec: string | undefined;
  stageId: string | undefined;
  rekor: boolean;
  repository: string | undefined;
  commit: string | undefined;
  registry: string | undefined;
  nodeMajor: number | undefined;
  image: string | undefined;
  buildCommand: string | undefined;
  memory: string | undefined;
  failOn: FailOn;
  createIssue: boolean;
  issueLabels: string[];
  reportPath: string;
  token: string;
}

export interface ActionContext {
  eventName: string;
  /** `owner/repo` of the workflow run. */
  repository: string;
  serverUrl: string;
  sha: string;
  workspace: string;
}

export type GetInput = (name: string) => string;

const GITHUB_REPOSITORY_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/;

/**
 * Events on which this action refuses to run. pull_request_target runs with the base
 * repository's secrets on a contributor-controlled pull request: it is the TanStack attack
 * vector, and a release check has no business there.
 */
export const FORBIDDEN_EVENTS = new Set(["pull_request_target"]);

function readWorkspaceManifest(workspace: string): {
  name?: string;
  version?: string;
  private?: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const { name, version, private: isPrivate } = parsed as Record<string, unknown>;
    return {
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof version === "string" ? { version } : {}),
      ...(typeof isPrivate === "boolean" ? { private: isPrivate } : {}),
    };
  } catch {
    return {};
  }
}

/** Parses and validates every input. Throws ToolError with a message a maintainer can act on. */
export function parseInputs(getInput: GetInput, context: ActionContext): ActionInputs {
  if (FORBIDDEN_EVENTS.has(context.eventName)) {
    throw new ToolError(
      `releaseproof refuses to run on ${context.eventName}: that event exposes repository secrets to contributor-controlled code. Run it on release, push, workflow_dispatch or workflow_run instead.`,
    );
  }
  const stageInput = getInput("stage").trim().toLowerCase();
  if (stageInput && !STAGE_ID_RE.test(stageInput)) {
    throw new ToolError(`Input "stage" must be a stage id (UUID), got "${stageInput}"`);
  }
  const rekorInput = getInput("rekor").trim().toLowerCase() || "true";
  if (!["true", "false"].includes(rekorInput)) {
    throw new ToolError(`Input "rekor" must be true or false, got "${rekorInput}"`);
  }
  const manifest = readWorkspaceManifest(context.workspace);
  const packageInput = getInput("package").trim();
  const versionInput = getInput("version").trim();
  if (
    manifest.private &&
    (!packageInput || !versionInput) &&
    (!stageInput || packageInput || versionInput)
  ) {
    throw new ToolError(
      'The root package.json is private (a monorepo?); set the "package" and "version" inputs to the package you publish',
    );
  }
  // A stage-only check does not need a spec. Never use a private root as its cross-check.
  const name = packageInput || (manifest.private ? undefined : manifest.name);
  const version = versionInput || (manifest.private ? undefined : manifest.version);
  let spec: string | undefined;
  if (name && version) {
    const parsed = parseSpec(`${name}@${version}`);
    spec = `${parsed.name}@${parsed.version}`;
  } else if (!stageInput) {
    throw new ToolError(
      'Inputs "package" and "version" are required when the checkout has no package.json with a name and version',
    );
  }

  const repoInput = getInput("repo")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (repoInput && !GITHUB_REPOSITORY_RE.test(repoInput)) {
    throw new ToolError(
      `Input "repo" must look like https://github.com/<owner>/<repo>, got "${repoInput}"`,
    );
  }
  const commitInput = getInput("commit").trim().toLowerCase();
  if (commitInput && !/^[0-9a-f]{40}$/.test(commitInput)) {
    throw new ToolError(`Input "commit" must be a full 40-character SHA, got "${commitInput}"`);
  }
  const nodeMajor = parseNodeMajorOption(getInput("node"), 'Input "node"');
  const memoryInput = parseMemoryLimit(getInput("memory"), 'Input "memory"');
  const imageInput = getInput("image");
  const failOnInput = (getInput("fail-on").trim() || "non-zero") as FailOn;
  if (!["non-zero", "differs", "never"].includes(failOnInput)) {
    throw new ToolError(`Input "fail-on" must be non-zero, differs or never, got "${failOnInput}"`);
  }
  const createIssueInput = getInput("create-issue").trim().toLowerCase();
  if (createIssueInput && !["true", "false"].includes(createIssueInput)) {
    throw new ToolError(`Input "create-issue" must be true or false, got "${createIssueInput}"`);
  }
  const reportPath = getInput("report-path").trim() || "releaseproof-report.json";
  if (path.isAbsolute(reportPath) || reportPath.split(/[\\/]/).includes("..")) {
    throw new ToolError(
      `Input "report-path" must be a relative path inside the workspace, got "${reportPath}"`,
    );
  }

  return {
    spec,
    stageId: stageInput || undefined,
    rekor: rekorInput === "true",
    repository: repoInput || undefined,
    commit: commitInput || undefined,
    registry: getInput("registry").trim() || undefined,
    nodeMajor,
    image: imageInput === "" ? undefined : validateImageReference(imageInput, 'Input "image"'),
    buildCommand: getInput("build-command").trim() || undefined,
    memory: memoryInput,
    failOn: failOnInput,
    createIssue: createIssueInput === "true",
    issueLabels: getInput("issue-labels")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== ""),
    reportPath,
    token: getInput("token"),
  };
}
