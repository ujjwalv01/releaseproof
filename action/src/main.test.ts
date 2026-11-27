import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CheckReport, ToolError } from "@releaseproof/core";
import { describe, expect, it, vi } from "vitest";
import { type ActionIo, runAction, selectReusableIssue } from "./main.js";

const sha = "a".repeat(40);

function reportWith(status: CheckReport["verdict"]["status"], exitCode: 0 | 1 | 2): CheckReport {
  return {
    package: {
      name: "releaseproof",
      version: "1.2.3",
      origin: "published",
      registry: "https://registry.npmjs.org/",
      sha512: "ab".repeat(32),
      files: 3,
    },
    provenance: {
      status: "missing",
      problems: ["no attestations"],
      warnings: [],
      mismatches: [],
      publishAttestation: { status: "missing" },
    },
    source: undefined,
    rebuild: undefined,
    diff: undefined,
    verdict: {
      status,
      exitCode,
      summary: `${status.toUpperCase()}: because`,
      reasons: ["because"],
      findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    durationMs: 1,
  };
}

function fakeIo(
  inputs: Record<string, string>,
  check: ActionIo["check"],
  overrides: Partial<ActionIo> = {},
) {
  const workspace = mkdtempSync(path.join(tmpdir(), "releaseproof-action-main-"));
  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "releaseproof", version: "1.2.3" }),
  );
  const io = {
    outputs: {} as Record<string, string>,
    failures: [] as string[],
    infos: [] as string[],
    warnings: [] as string[],
    summaries: [] as string[],
    files: {} as Record<string, string>,
    issues: [] as Array<{
      number: number;
      url: string;
      title: string;
      body: string;
      labels: string[];
    }>,
    comments: [] as Array<{ issueNumber: number; body: string }>,
  };
  const actionIo: ActionIo = {
    getInput: (name) => inputs[name] ?? "",
    context: {
      eventName: "release",
      repository: "ujjwalv01/releaseproof",
      serverUrl: "https://github.com",
      sha,
      workspace,
      runUrl: "https://github.com/ujjwalv01/releaseproof/actions/runs/7",
    },
    setOutput: (name, value) => {
      io.outputs[name] = value;
    },
    setFailed: (message) => {
      io.failures.push(message);
    },
    info: (message) => {
      io.infos.push(message);
    },
    warning: (message) => {
      io.warnings.push(message);
    },
    writeSummary: async (markdown) => {
      io.summaries.push(markdown);
    },
    writeFile: (relativePath, contents) => {
      io.files[relativePath] = contents;
    },
    findOpenIssue: async ({ title, labels }) => {
      const match = io.issues.find(
        (issue) => issue.title === title && labels.every((label) => issue.labels.includes(label)),
      );
      return match ? { number: match.number, url: match.url } : undefined;
    },
    commentOnIssue: async ({ issueNumber, body }) => {
      io.comments.push({ issueNumber, body });
    },
    createIssue: async ({ title, body, labels }) => {
      const number = io.issues.length + 1;
      const url = `https://github.com/ujjwalv01/releaseproof/issues/${number}`;
      io.issues.push({ number, url, title, body, labels });
      return url;
    },
    check,
    ...overrides,
  };
  return { io, actionIo };
}

describe("runAction", () => {
  it.each(["--privileged", "node:", "node:22\n", "node\0", "   "])(
    "rejects image %j before running a check",
    async (image) => {
      const check = vi.fn(async () => reportWith("matches-source", 0));
      const { io, actionIo } = fakeIo({ image }, check);
      await runAction(actionIo);
      expect(check).not.toHaveBeenCalled();
      expect(io.failures).toEqual([
        `Input "image" must be a Docker image reference such as node:22-bookworm, got ${JSON.stringify(image)}`,
      ]);
      expect(io.outputs).toEqual({});
      expect(io.files).toEqual({});
    },
  );

  it.each(["node:22-bookworm", "registry.example.com:5000/team/node:22", ""])(
    "passes valid or absent image %j through",
    async (image) => {
      const check = vi.fn(async (_options: Parameters<ActionIo["check"]>[0]) =>
        reportWith("matches-source", 0),
      );
      const { io, actionIo } = fakeIo({ image }, check);
      await runAction(actionIo);
      expect(check.mock.calls[0]?.[0].image).toBe(image || undefined);
      expect(io.failures).toEqual([]);
    },
  );

  it("runs the check with the inputs, writes outputs, summary and JSON, and fails on a non-zero verdict", async () => {
    const check = vi.fn(async (_options: Parameters<ActionIo["check"]>[0]) =>
      reportWith("differs-from-source", 1),
    );
    const { io, actionIo } = fakeIo(
      { repo: "https://github.com/ujjwalv01/releaseproof", commit: sha, token: "t" },
      check,
    );
    await runAction(actionIo);

    expect(check.mock.calls[0]?.[0]).toMatchObject({
      spec: "releaseproof@1.2.3",
      repository: "https://github.com/ujjwalv01/releaseproof",
      commit: sha,
      rekor: true,
    });
    expect(io.outputs).toMatchObject({
      verdict: "differs-from-source",
      "exit-code": "1",
      findings: "0",
      "highest-severity": "none",
      "report-path": "releaseproof-report.json",
    });
    expect(JSON.parse(io.files["releaseproof-report.json"] ?? "{}")).toMatchObject({
      verdict: { status: "differs-from-source" },
    });
    expect(io.summaries[0]).toContain("## 🚨 DIFFERS FROM SOURCE — `releaseproof@1.2.3`");
    expect(io.failures).toEqual(["DIFFERS-FROM-SOURCE: because"]);
    expect(io.issues).toEqual([]);
  });

  it("sets findings count and highest-severity from sorted findings", async () => {
    const report = reportWith("differs-from-source", 1);
    report.verdict.findings = [
      {
        id: "readme-changed",
        severity: "low",
        title: "Changed non-code file",
        detail: "README.md changed",
        paths: ["package/README.md"],
      },
      {
        id: "file-added",
        severity: "high",
        title: "Added executable file",
        detail: "package/extra.js added",
        paths: ["package/extra.js"],
      },
      {
        id: "file-changed",
        severity: "high",
        title: "Modified executable file",
        detail: "package/index.js changed",
        paths: ["package/index.js"],
      },
    ];
    report.verdict.counts = { critical: 0, high: 2, medium: 0, low: 1, info: 0 };

    const { io, actionIo } = fakeIo({}, async () => report);
    await runAction(actionIo);

    expect(io.outputs.findings).toBe("3");
    expect(io.outputs["highest-severity"]).toBe("high");
  });

  it("opens an issue when asked and the verdict is not a match", async () => {
    const { io, actionIo } = fakeIo(
      { "create-issue": "true", "issue-labels": "security", token: "t" },
      async () => reportWith("could-not-verify", 2),
    );
    await runAction(actionIo);
    expect(io.issues).toHaveLength(1);
    expect(io.issues[0]).toMatchObject({
      title: "releaseproof: releaseproof@1.2.3 COULD NOT VERIFY",
      labels: ["security"],
    });
    expect(io.outputs["issue-url"]).toBe("https://github.com/ujjwalv01/releaseproof/issues/1");

    const matched = fakeIo({ "create-issue": "true" }, async () => reportWith("matches-source", 0));
    await runAction(matched.actionIo);
    expect(matched.io.issues).toEqual([]);
    expect(matched.io.failures).toEqual([]);
  });

  it("honours fail-on and never hides a could-not-verify behind a green job by default", async () => {
    const differs = fakeIo({ "fail-on": "differs" }, async () => reportWith("could-not-verify", 2));
    await runAction(differs.actionIo);
    expect(differs.io.failures).toEqual([]);
    expect(differs.io.outputs["exit-code"]).toBe("2");

    const never = fakeIo({ "fail-on": "never" }, async () => reportWith("differs-from-source", 1));
    await runAction(never.actionIo);
    expect(never.io.failures).toEqual([]);

    const byDefault = fakeIo({}, async () => reportWith("could-not-verify", 2));
    await runAction(byDefault.actionIo);
    expect(byDefault.io.failures).toHaveLength(1);
  });

  it.each(["never", "differs"] as const)(
    "fails the job on a tool error even when fail-on is %j, while still setting outputs",
    async (failOn) => {
      const toolError = fakeIo({ "fail-on": failOn }, async () => {
        throw new ToolError("registry is unreachable");
      });
      await runAction(toolError.actionIo);
      expect(toolError.io.failures).toEqual(["could not verify: registry is unreachable"]);
      expect(toolError.io.outputs).toMatchObject({
        verdict: "could-not-verify",
        "exit-code": "2",
        summary: "registry is unreachable",
      });
    },
  );

  it("sets outputs and a summary before failing closed when the check itself errors", async () => {
    const broken = fakeIo({}, async () => {
      throw new ToolError("Docker is not available");
    });
    await runAction(broken.actionIo);
    expect(broken.io.failures).toEqual(["could not verify: Docker is not available"]);
    expect(broken.io.outputs).toEqual({
      verdict: "could-not-verify",
      "exit-code": "2",
      summary: "Docker is not available",
    });
    expect(broken.io.outputs.findings).toBeUndefined();
    expect(broken.io.outputs["highest-severity"]).toBeUndefined();
    expect(broken.io.summaries).toHaveLength(1);
    expect(broken.io.summaries[0]).toContain("## ⚠️ COULD NOT VERIFY — the check itself failed");
    expect(broken.io.summaries[0]).toContain("```text\nDocker is not available\n```");
    expect(broken.io.issues).toEqual([]);
    expect(broken.io.files).toEqual({});

    const badInput = fakeIo({ node: "x" }, async () => reportWith("matches-source", 0));
    await runAction(badInput.actionIo);
    expect(badInput.io.failures[0]).toMatch(/Input "node"/);
    expect(badInput.io.outputs).toEqual({});
  });

  it("opens an issue when asked even when the check itself errors", async () => {
    const { io, actionIo } = fakeIo(
      { "create-issue": "true", "issue-labels": "security", token: "t" },
      async () => {
        throw new ToolError("registry is unreachable");
      },
    );
    await runAction(actionIo);
    expect(io.outputs).toEqual({
      verdict: "could-not-verify",
      "exit-code": "2",
      summary: "registry is unreachable",
      "issue-url": "https://github.com/ujjwalv01/releaseproof/issues/1",
    });
    expect(io.issues).toHaveLength(1);
    expect(io.issues[0]).toMatchObject({
      title: "releaseproof: could not verify",
      labels: ["security"],
      body: io.summaries[0],
    });
    expect(io.failures).toEqual(["could not verify: registry is unreachable"]);
  });

  it("only warns when the issue cannot be opened", async () => {
    const { io, actionIo } = fakeIo(
      { "create-issue": "true" },
      async () => reportWith("differs-from-source", 1),
      {
        createIssue: async () => {
          throw new Error("Resource not accessible by integration");
        },
      },
    );
    await runAction(actionIo);
    expect(io.warnings[0]).toMatch(
      /could not open an issue .*issues: write.*Resource not accessible/,
    );
    expect(io.failures).toEqual(["DIFFERS-FROM-SOURCE: because"]);
  });

  it("reuses an open issue by commenting on it when the package, version and verdict match", async () => {
    const { io, actionIo } = fakeIo(
      { "create-issue": "true", "issue-labels": "security", token: "t" },
      async () => reportWith("differs-from-source", 1),
    );
    await runAction(actionIo);
    await runAction(actionIo);

    expect(io.issues).toHaveLength(1);
    expect(io.comments).toHaveLength(1);
    expect(io.comments[0]?.issueNumber).toBe(1);
    expect(io.outputs["issue-url"]).toBe("https://github.com/ujjwalv01/releaseproof/issues/1");
  });

  it("opens a new issue when the version or verdict differs", async () => {
    let report = reportWith("differs-from-source", 1);
    const { io, actionIo } = fakeIo(
      { "create-issue": "true", "issue-labels": "security", token: "t" },
      async () => report,
    );
    await runAction(actionIo);

    report = reportWith("could-not-verify", 2);
    await runAction(actionIo);

    report = {
      ...reportWith("differs-from-source", 1),
      package: { ...reportWith("differs-from-source", 1).package, version: "1.2.4" },
    };
    await runAction(actionIo);

    expect(io.issues).toHaveLength(3);
    expect(io.comments).toHaveLength(0);
    expect(io.outputs["issue-url"]).toBe("https://github.com/ujjwalv01/releaseproof/issues/3");
  });

  it("reuses the open issue on repeated tool errors", async () => {
    const { io, actionIo } = fakeIo(
      { "create-issue": "true", "issue-labels": "security", token: "t" },
      async () => {
        throw new ToolError("registry is unreachable");
      },
    );
    await runAction(actionIo);
    await runAction(actionIo);

    expect(io.issues).toHaveLength(1);
    expect(io.issues[0]?.title).toBe("releaseproof: could not verify");
    expect(io.comments).toHaveLength(1);
    expect(io.comments[0]?.issueNumber).toBe(1);
    expect(io.outputs["issue-url"]).toBe("https://github.com/ujjwalv01/releaseproof/issues/1");
  });

  it("warns and opens a new issue if looking up an existing issue fails", async () => {
    const { io, actionIo } = fakeIo(
      { "create-issue": "true", token: "t" },
      async () => reportWith("differs-from-source", 1),
      {
        findOpenIssue: async () => {
          throw new Error("API rate limit exceeded");
        },
      },
    );
    await runAction(actionIo);

    expect(io.warnings[0]).toMatch(
      /could not check for an existing issue: API rate limit exceeded/,
    );
    expect(io.issues).toHaveLength(1);
    expect(io.outputs["issue-url"]).toBe("https://github.com/ujjwalv01/releaseproof/issues/1");
  });
});

describe("selectReusableIssue", () => {
  const title = "releaseproof: demo@1.2.3 differs-from-source";

  it("ignores an outsider's open issue with the same title", () => {
    const result = selectReusableIssue(
      [
        {
          number: 10,
          html_url: "https://github.com/ujjwalv01/releaseproof/issues/10",
          title,
          user: { type: "User" },
          author_association: "NONE",
        },
        {
          number: 11,
          html_url: "https://github.com/ujjwalv01/releaseproof/issues/11",
          title,
          user: { type: "User" },
          author_association: "CONTRIBUTOR",
        },
      ],
      title,
    );
    expect(result).toBeUndefined();
  });

  it("reuses an open issue opened by a bot", () => {
    const result = selectReusableIssue(
      [
        {
          number: 12,
          html_url: "https://github.com/ujjwalv01/releaseproof/issues/12",
          title,
          user: { type: "Bot" },
          author_association: "NONE",
        },
      ],
      title,
    );
    expect(result).toEqual({
      number: 12,
      url: "https://github.com/ujjwalv01/releaseproof/issues/12",
    });
  });

  it("reuses an open issue opened by a repository maintainer and skips pull requests", () => {
    const result = selectReusableIssue(
      [
        {
          number: 13,
          html_url: "https://github.com/ujjwalv01/releaseproof/pull/13",
          title,
          pull_request: {},
          user: { type: "User" },
          author_association: "OWNER",
        },
        {
          number: 14,
          html_url: "https://github.com/ujjwalv01/releaseproof/issues/14",
          title,
          user: { type: "User" },
          author_association: "COLLABORATOR",
        },
      ],
      title,
    );
    expect(result).toEqual({
      number: 14,
      url: "https://github.com/ujjwalv01/releaseproof/issues/14",
    });
  });
});
