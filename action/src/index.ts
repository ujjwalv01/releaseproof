import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { runCheck } from "@releaseproof/core";
import { runAction } from "./main.js";

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const { context } = github;

await runAction({
  getInput: (name) => core.getInput(name, { trimWhitespace: name !== "image" }),
  context: {
    eventName: context.eventName,
    repository: `${context.repo.owner}/${context.repo.repo}`,
    serverUrl: context.serverUrl,
    sha: context.sha,
    workspace,
    runUrl: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  },
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (message) => core.setFailed(message),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  writeSummary: async (markdown) => {
    await core.summary.addRaw(markdown).write();
  },
  writeFile: (relativePath, contents) => {
    const file = path.join(workspace, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  },
  createIssue: async ({ token, title, body, labels }) => {
    const octokit = github.getOctokit(token);
    const { data } = await octokit.rest.issues.create({ ...context.repo, title, body, labels });
    return data.html_url;
  },
  check: (options) => runCheck(options),
});
