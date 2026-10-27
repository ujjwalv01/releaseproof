import {
  type CheckOptions,
  type CheckReport,
  ExitCode,
  formatReport,
  runCheck,
  ToolError,
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
  quiet?: boolean | undefined;
}

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CheckCommandDeps {
  runCheck: (options: CheckOptions) => Promise<CheckReport>;
}

function parseNodeMajor(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const major = Number(value);
  if (!Number.isInteger(major) || major < 10 || major > 40) {
    throw new ToolError(`--node expects a Node.js major version such as 22, got "${value}"`);
  }
  return major;
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
  try {
    const report = await deps.runCheck({
      spec,
      stageId: options.stage,
      registry: options.registry,
      token: options.token,
      repository: options.repo,
      commit: options.commit,
      image: options.image,
      nodeMajor: parseNodeMajor(options.node),
      buildCommand: options.buildCommand,
      memory: options.memory,
      offline: options.offline,
      rekor: options.rekor,
      keepVolume: options.keepVolume,
      log: options.quiet ? undefined : (line) => io.stderr(`… ${line}\n`),
    });
    io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.verdict.exitCode;
  } catch (error) {
    if (error instanceof ToolError) {
      io.stderr(`error: ${error.message}\n`);
      return ExitCode.ToolError;
    }
    throw error;
  }
}
