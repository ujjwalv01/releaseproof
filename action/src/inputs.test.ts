import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolError } from "@releaseproof/core";
import { describe, expect, it } from "vitest";
import { type ActionContext, parseInputs } from "./inputs.js";

const sha = "a".repeat(40);

function workspaceWith(manifest: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "releaseproof-action-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    eventName: "release",
    repository: "ujjwalv01/releaseproof",
    serverUrl: "https://github.com",
    sha,
    workspace: workspaceWith({ name: "releaseproof", version: "1.2.3" }),
    ...overrides,
  };
}

function inputs(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

describe("parseInputs", () => {
  it("defaults package and version from the checkout's package.json", () => {
    const parsed = parseInputs(
      inputs({ repo: "https://github.com/ujjwalv01/releaseproof", commit: sha, token: "t" }),
      context(),
    );
    expect(parsed).toMatchObject({
      spec: "releaseproof@1.2.3",
      repository: "https://github.com/ujjwalv01/releaseproof",
      commit: sha,
      failOn: "non-zero",
      createIssue: false,
      issueLabels: [],
      reportPath: "releaseproof-report.json",
      token: "t",
    });
  });

  it("prefers explicit inputs and validates them with the CLI's rules", () => {
    const parsed = parseInputs(
      inputs({
        package: "@scope/pkg",
        version: "2.0.0",
        node: "24",
        "fail-on": "differs",
        "create-issue": "TRUE",
        "issue-labels": "security, releaseproof ,",
        "report-path": "out/report.json",
        repo: "https://github.com/o/r.git/",
      }),
      context(),
    );
    expect(parsed).toMatchObject({
      spec: "@scope/pkg@2.0.0",
      nodeMajor: 24,
      failOn: "differs",
      createIssue: true,
      issueLabels: ["security", "releaseproof"],
      reportPath: "out/report.json",
      repository: "https://github.com/o/r",
    });
    expect(() => parseInputs(inputs({ version: "latest" }), context())).toThrow(/exact version/);
  });

  it("refuses to run on pull_request_target", () => {
    expect(() => parseInputs(inputs({}), context({ eventName: "pull_request_target" }))).toThrow(
      /refuses to run on pull_request_target/,
    );
  });

  it("rejects malformed repo, commit, node, fail-on, create-issue and report-path", () => {
    const bad: Array<[Record<string, string>, RegExp]> = [
      [{ repo: "https://gitlab.com/o/r" }, /must look like https:\/\/github.com/],
      [{ commit: "abc" }, /full 40-character SHA/],
      [{ node: "twenty" }, /Node.js major/],
      [{ "fail-on": "sometimes" }, /non-zero, differs or never/],
      [{ "create-issue": "yes" }, /true or false/],
      [{ "report-path": "../escape.json" }, /relative path inside the workspace/],
      [{ "report-path": "/tmp/x.json" }, /relative path inside the workspace/],
    ];
    for (const [values, message] of bad) {
      expect(() => parseInputs(inputs(values), context()), JSON.stringify(values)).toThrow(message);
    }
  });

  it("requires package and version when the workspace has no usable package.json", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "releaseproof-action-empty-"));
    expect(() => parseInputs(inputs({}), context({ workspace: empty }))).toThrow(ToolError);
    expect(
      parseInputs(inputs({ package: "x", version: "1.0.0" }), context({ workspace: empty })).spec,
    ).toBe("x@1.0.0");
  });
});

describe("parseInputs with a stage id", () => {
  it("accepts a stage id, with the package spec as an optional cross-check", () => {
    const parsed = parseInputs(
      inputs({ stage: "123E4567-e89b-12d3-a456-426614174000" }),
      context(),
    );
    expect(parsed.stageId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(parsed.spec).toBe("releaseproof@1.2.3");
    const empty = mkdtempSync(path.join(tmpdir(), "releaseproof-action-stage-"));
    const noSpec = parseInputs(
      inputs({ stage: "123e4567-e89b-12d3-a456-426614174000" }),
      context({ workspace: empty }),
    );
    expect(noSpec.spec).toBeUndefined();
  });

  it("rejects a malformed stage id", () => {
    expect(() => parseInputs(inputs({ stage: "../approve" }), context())).toThrow(
      /stage id \(UUID\)/,
    );
  });
});

describe("parseInputs memory", () => {
  it("accepts Docker sizes and rejects anything else", () => {
    expect(parseInputs(inputs({ memory: "6G" }), context()).memory).toBe("6g");
    expect(parseInputs(inputs({}), context()).memory).toBeUndefined();
    expect(() => parseInputs(inputs({ memory: "lots" }), context())).toThrow(/Docker size/);
  });

  it.each([
    ["4g", "4g"],
    ["6144m", "6144m"],
    ["512", "512"],
    [" 6G ", "6g"],
    ["", undefined],
    ["   ", undefined],
  ])("normalizes %j", (memory, expected) => {
    expect(parseInputs(inputs({ memory }), context()).memory).toBe(expected);
  });

  it.each(["4gb", "four", "-1g", "4g --privileged", "4g; echo unsafe", "4g\0", "4\n2g"])(
    "rejects %j with the existing input message",
    (memory) => {
      expect(() => parseInputs(inputs({ memory }), context())).toThrow(
        new ToolError(`Input "memory" must be a Docker size such as 4g or 6144m, got "${memory}"`),
      );
    },
  );
});
