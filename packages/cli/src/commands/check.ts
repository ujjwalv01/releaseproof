import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CheckOptions,
  type CheckReport,
  ExitCode,
  formatReport,
  parseMemoryLimit,
  parseNodeMajorOption,
  runCheck,
  ToolError,
  validateImageReference,
} from "@releaseproof/core";

export interface CheckCommandOptions {
  stage?: string | undefined;
  registry?: string | undefined;
  token?: string | undefined;
  repo?: string | undefined;
  commit?: string | undefined;
  image?: string | undefined;
  node?: string | undefined;
  buildCommand?: string | undefined;
  memory?: string | undefined;
  offline?: boolean | undefined;
  /** False with --no-rekor. */
  rekor?: boolean | undefined;
  keepVolume?: boolean | undefined;
  json?: boolean | undefined;
  report?: string | undefined;
  patchLines?: string | undefined;
  quiet?: boolean | undefined;
}

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CheckCommandDeps {
  runCheck: (options: CheckOptions) => Promise<CheckReport>;
}

function parsePatchLines(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new ToolError(
      `--patch-lines expects a whole number 0 or more, got ${JSON.stringify(value)}`,
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new ToolError(
      `--patch-lines expects a whole number 0 or more, got ${JSON.stringify(value)}`,
    );
  }
  return count;
}

function reportWriteError(filePath: string, error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ToolError(`could not write report to ${filePath}: ${detail}`);
}

function validateReportPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value.trim() || value.includes("\0")) {
    throw new ToolError(`--report expects a file path, got ${JSON.stringify(value)}`);
  }
  try {
    const dir = path.dirname(value);
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    try {
      const existing = statSync(value);
      if (existing.isDirectory()) {
        throw new ToolError(`could not write report to ${value}: path is a directory`);
      }
      accessSync(value, constants.W_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  } catch (error) {
    throw reportWriteError(value, error);
  }
  return value;
}

function writeReportFile(filePath: string, jsonText: string): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, jsonText, "utf8");
  } catch (error) {
    throw reportWriteError(filePath, error);
  }
}

/**
 * `releaseproof check <name>@<version>`. Progress goes to stderr, the report to stdout,
 * and the exit code is the verdict's: 0 match, 1 differs, 2 could not verify / tool error.
 */
export async function runCheckCommand(
  spec: string | undefined,
  options: CheckCommandOptions,
  io: CommandIo,
  deps: CheckCommandDeps = { runCheck },
): Promise<ExitCode> {
  if (options.token !== undefined && !options.quiet) {
    // Never echo the token itself.
    io.stderr(
      "warning: --token is visible in shell history and process lists; prefer NPM_TOKEN or npm login\n",
    );
  }
  try {
    const maxPatchLines = parsePatchLines(options.patchLines);
    const reportPath = validateReportPath(options.report);
    const report = await deps.runCheck({
      spec,
      stageId: options.stage,
      registry: options.registry,
      token: options.token,
      repository: options.repo,
      commit: options.commit,
      image: options.image === undefined ? undefined : validateImageReference(options.image),
      nodeMajor: parseNodeMajorOption(options.node),
      buildCommand: options.buildCommand,
      memory: parseMemoryLimit(options.memory),
      offline: options.offline,
      rekor: options.rekor,
      keepVolume: options.keepVolume,
      log: options.quiet ? undefined : (line) => io.stderr(`… ${line}\n`),
    });
    const jsonReport =
      options.json || reportPath !== undefined ? `${JSON.stringify(report, null, 2)}\n` : undefined;
    if (reportPath !== undefined && jsonReport !== undefined) {
      writeReportFile(reportPath, jsonReport);
    }
    io.stdout(
      options.json && jsonReport !== undefined
        ? jsonReport
        : formatReport(report, maxPatchLines === undefined ? {} : { maxPatchLines }),
    );
    return report.verdict.exitCode;
  } catch (error) {
    if (error instanceof ToolError) {
      io.stderr(`error: ${error.message}\n`);
      if (options.json) {
        // A script piping stdout to jq still gets one JSON object; the `error` key
        // tells it apart from a report. See docs/json-report.md.
        io.stdout(`${JSON.stringify({ error: { message: error.message } }, null, 2)}\n`);
      }
      return ExitCode.ToolError;
    }
    throw error;
  }
}
