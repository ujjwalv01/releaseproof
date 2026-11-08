import {
  type CheckReport,
  ExitCode,
  formatReport,
  type runCheck,
  ToolError,
} from "@releaseproof/core";
import { type ActionContext, type ActionInputs, type GetInput, parseInputs } from "./inputs.js";
import { issueTitle, renderMarkdown, renderToolErrorMarkdown } from "./report.js";

/** Everything the action touches outside pure computation. Faked in tests. */
export interface ActionIo {
  getInput: GetInput;
  context: ActionContext & { runUrl: string };
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  writeSummary(markdown: string): Promise<void>;
  writeFile(relativePath: string, contents: string): void;
  createIssue(args: {
    token: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<string>;
  check(options: Parameters<typeof runCheck>[0]): Promise<CheckReport>;
}

function shouldFail(exitCode: ExitCode, failOn: ActionInputs["failOn"]): boolean {
  switch (failOn) {
    case "never":
      return false;
    case "differs":
      return exitCode === ExitCode.Differs;
    default:
      return exitCode !== ExitCode.Match;
  }
}

/** The action's whole behaviour, independent of @actions/* so it can be tested directly. */
export async function runAction(io: ActionIo): Promise<void> {
  let inputs: ActionInputs;
  try {
    inputs = parseInputs(io.getInput, io.context);
  } catch (error) {
    if (error instanceof ToolError) {
      io.setFailed(error.message);
      return;
    }
    throw error;
  }

  let report: CheckReport;
  try {
    report = await io.check({
      spec: inputs.spec,
      stageId: inputs.stageId,
      registry: inputs.registry,
      repository: inputs.repository,
      commit: inputs.commit,
      nodeMajor: inputs.nodeMajor,
      image: inputs.image,
      buildCommand: inputs.buildCommand,
      memory: inputs.memory,
      log: (line) => io.info(line),
    });
  } catch (error) {
    if (error instanceof ToolError) {
      // Environment problems (registry, Docker, bad options) still leave outputs, a summary
      // and an issue behind before the job fails closed with the reason.
      io.setOutput("verdict", "could-not-verify");
      io.setOutput("exit-code", String(ExitCode.ToolError));
      io.setOutput("summary", error.message);
      const markdown = renderToolErrorMarkdown(error.message, { runUrl: io.context.runUrl });
      await io.writeSummary(markdown);
      if (inputs.createIssue) {
        try {
          const url = await io.createIssue({
            token: inputs.token,
            title: "releaseproof: could not verify",
            body: markdown,
            labels: inputs.issueLabels,
          });
          io.setOutput("issue-url", url);
          io.info(`opened ${url}`);
        } catch (issueError) {
          io.warning(
            `could not open an issue (does the job have "issues: write"?): ${issueError instanceof Error ? issueError.message : String(issueError)}`,
          );
        }
      }
      io.setFailed(`could not verify: ${error.message}`);
      return;
    }
    throw error;
  }

  const text = formatReport(report);
  io.writeFile(inputs.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  io.setOutput("verdict", report.verdict.status);
  io.setOutput("exit-code", String(report.verdict.exitCode));
  io.setOutput("summary", report.verdict.summary);
  io.setOutput("report-path", inputs.reportPath);
  io.info(text);

  const markdown = renderMarkdown(report, text, {
    runUrl: io.context.runUrl,
    reportPath: inputs.reportPath,
  });
  await io.writeSummary(markdown);

  if (inputs.createIssue && report.verdict.status !== "matches-source") {
    try {
      const url = await io.createIssue({
        token: inputs.token,
        title: issueTitle(report),
        body: markdown,
        labels: inputs.issueLabels,
      });
      io.setOutput("issue-url", url);
      io.info(`opened ${url}`);
    } catch (error) {
      io.warning(
        `could not open an issue (does the job have "issues: write"?): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (shouldFail(report.verdict.exitCode, inputs.failOn)) {
    io.setFailed(report.verdict.summary);
  }
}
