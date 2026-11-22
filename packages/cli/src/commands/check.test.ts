import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CheckOptions, type CheckReport, ToolError } from "@releaseproof/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheckCommand } from "./check.js";

function fakeReport(exitCode: 0 | 1 | 2): CheckReport {
  return {
    package: {
      name: "x",
      version: "1.0.0",
      origin: "published",
      registry: "https://registry.npmjs.org/",
      sha512: "ab".repeat(32),
      files: 1,
    },
    provenance: {
      status: "missing",
      problems: [],
      warnings: [],
      mismatches: [],
      publishAttestation: { status: "missing" },
    },
    source: undefined,
    rebuild: undefined,
    diff: undefined,
    verdict: {
      status: "could-not-verify",
      exitCode,
      summary: "summary",
      reasons: ["r"],
      findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    durationMs: 1,
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
  };
}

describe("runCheckCommand", () => {
  it("maps options, streams progress to stderr and returns the verdict's exit code", async () => {
    const runCheck = vi.fn(async (options: CheckOptions) => {
      options.log?.("fetching x@1.0.0");
      return fakeReport(1);
    });
    const { out, err, io: streams } = io();
    const code = await runCheckCommand(
      "x@1.0.0",
      { repo: "https://github.com/o/r", node: "22", keepVolume: true, rekor: false },
      streams,
      { runCheck },
    );
    expect(code).toBe(1);
    expect(runCheck.mock.calls[0]?.[0]).toMatchObject({
      spec: "x@1.0.0",
      repository: "https://github.com/o/r",
      nodeMajor: 22,
      keepVolume: true,
      rekor: false,
    });
    expect(err).toEqual(["… fetching x@1.0.0\n"]);
    expect(out.join("")).toContain("Verdict: summary");
  });

  it("prints JSON when asked and stays quiet with --quiet", async () => {
    const runCheck = vi.fn(async (options: CheckOptions) => {
      expect(options.log).toBeUndefined();
      return fakeReport(0);
    });
    const { out, err, io: streams } = io();
    const code = await runCheckCommand("x@1.0.0", { json: true, quiet: true }, streams, {
      runCheck,
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join(""))).toMatchObject({
      verdict: { status: "could-not-verify", exitCode: 0 },
    });
  });

  it("turns ToolError into exit code 2 with a message, and rejects a bad --node", async () => {
    const runCheck = vi.fn(async () => {
      throw new ToolError("Docker is not available");
    });
    const { err, io: streams } = io();
    expect(await runCheckCommand("x@1.0.0", {}, streams, { runCheck })).toBe(2);
    expect(err).toEqual(["error: Docker is not available\n"]);
    expect(await runCheckCommand("x@1.0.0", { node: "twenty" }, streams, { runCheck })).toBe(2);
    expect(err[1]).toMatch(/--node expects a Node.js major version/);
  });

  it("with --json a ToolError prints one error object to stdout and keeps the stderr line", async () => {
    const runCheck = vi.fn(async () => {
      throw new ToolError("Docker is not available");
    });
    const { out, err, io: streams } = io();
    expect(await runCheckCommand("x@1.0.0", { json: true }, streams, { runCheck })).toBe(2);
    expect(err).toEqual(["error: Docker is not available\n"]);
    expect(JSON.parse(out.join(""))).toEqual({ error: { message: "Docker is not available" } });
  });

  it("without --json a ToolError leaves stdout empty", async () => {
    const runCheck = vi.fn(async () => {
      throw new ToolError("Docker is not available");
    });
    const { out, err, io: streams } = io();
    expect(await runCheckCommand("x@1.0.0", {}, streams, { runCheck })).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(["error: Docker is not available\n"]);
  });
});

describe("runCheckCommand with --image", () => {
  it.each(["--privileged", "node:", "node:22\n", "node\0", ""])(
    "rejects %j before running a check",
    async (image) => {
      const runCheck = vi.fn(async () => fakeReport(0));
      const streams = io();
      expect(await runCheckCommand("x@1.0.0", { image }, streams.io, { runCheck })).toBe(2);
      expect(runCheck).not.toHaveBeenCalled();
      expect(streams.out).toEqual([]);
      expect(streams.err).toEqual([
        `error: --image must be a Docker image reference such as node:22-bookworm, got ${JSON.stringify(image)}\n`,
      ]);
    },
  );

  it.each(["node:22-bookworm", "registry.example.com:5000/team/node:22", undefined])(
    "passes valid image %j through unchanged",
    async (image) => {
      const runCheck = vi.fn(async (_options: CheckOptions) => fakeReport(0));
      expect(await runCheckCommand("x@1.0.0", { image }, io().io, { runCheck })).toBe(0);
      expect(runCheck.mock.calls[0]?.[0].image).toBe(image);
    },
  );
});

describe("runCheckCommand with --memory", () => {
  it.each([
    "0",
    "0g",
    "5m",
    "4096",
    "1k",
    "4gb",
    "four",
    "-1g",
    "4g --privileged",
    "4g; echo unsafe",
    "4g\0",
    "4\n2g",
  ])("rejects %j before running a check", async (memory) => {
    const runCheck = vi.fn(async () => fakeReport(0));
    const streams = io();
    expect(await runCheckCommand("x@1.0.0", { memory }, streams.io, { runCheck })).toBe(2);
    expect(runCheck).not.toHaveBeenCalled();
    expect(streams.out).toEqual([]);
    expect(streams.err).toEqual([
      `error: --memory must be a Docker size such as 4g or 6144m, got "${memory}"\n`,
    ]);
  });

  it.each([
    ["4g", "4g"],
    ["6144m", "6144m"],
    ["6m", "6m"],
    [" 4G ", "4g"],
    [" 6G ", "6g"],
    ["", undefined],
    ["   ", undefined],
    [undefined, undefined],
  ])("normalizes %j before running a check", async (memory, expected) => {
    const runCheck = vi.fn(async (_options: CheckOptions) => fakeReport(0));
    expect(await runCheckCommand("x@1.0.0", { memory }, io().io, { runCheck })).toBe(0);
    expect(runCheck).toHaveBeenCalledOnce();
    expect(runCheck.mock.calls[0]?.[0].memory).toBe(expected);
  });
});

describe("runCheckCommand with --token", () => {
  const warning =
    "warning: --token is visible in shell history and process lists; prefer NPM_TOKEN or npm login\n";

  it("warns on stderr without printing the token, and still passes it on", async () => {
    const runCheck = vi.fn(async (_options: CheckOptions) => fakeReport(0));
    const { out, err, io: streams } = io();
    const code = await runCheckCommand("x@1.0.0", { token: "npm_secret123" }, streams, {
      runCheck,
    });
    expect(code).toBe(0);
    expect(err[0]).toBe(warning);
    expect([...err, ...out].join("")).not.toContain("npm_secret123");
    expect(runCheck.mock.calls[0]?.[0]).toMatchObject({ token: "npm_secret123" });
  });

  it("says nothing without --token, and nothing with --quiet", async () => {
    const runCheck = vi.fn(async () => fakeReport(0));
    const without = io();
    await runCheckCommand("x@1.0.0", {}, without.io, { runCheck });
    expect(without.err).not.toContain(warning);

    const quiet = io();
    await runCheckCommand("x@1.0.0", { token: "npm_secret123", quiet: true }, quiet.io, {
      runCheck,
    });
    expect(quiet.err).toEqual([]);
  });
});

describe("runCheckCommand with --stage", () => {
  it("passes the stage id through and allows the package argument to be absent", async () => {
    const runCheck = vi.fn(async (_options: CheckOptions) => fakeReport(2));
    const { io: streams } = io();
    await runCheckCommand(
      undefined,
      { stage: "123e4567-e89b-12d3-a456-426614174000", quiet: true },
      streams,
      {
        runCheck,
      },
    );
    expect(runCheck.mock.calls[0]?.[0]).toMatchObject({
      spec: undefined,
      stageId: "123e4567-e89b-12d3-a456-426614174000",
    });
  });
});

describe("runCheckCommand with --repo", () => {
  // The real core runCheck rejects these before fetching anything, so the default
  // deps keep the test offline and prove the exit code end to end.
  it.each(["github.com/o/r", "nope"])(
    "rejects %j with exit code 2 before any fetch",
    async (repo) => {
      const streams = io();
      const code = await runCheckCommand("x@1.0.0", { repo }, streams.io);
      expect(code).toBe(2);
      expect(streams.out).toEqual([]);
      expect(streams.err).toEqual([
        `error: --repo must be a GitHub repository such as https://github.com/owner/repo or owner/repo, got ${JSON.stringify(repo)}\n`,
      ]);
    },
  );

  it("passes a readable --repo through unchanged", async () => {
    const runCheck = vi.fn(async (_options: CheckOptions) => fakeReport(0));
    expect(
      await runCheckCommand("x@1.0.0", { repo: "git+https://github.com/o/r.git" }, io().io, {
        runCheck,
      }),
    ).toBe(0);
    expect(runCheck.mock.calls[0]?.[0].repository).toBe("git+https://github.com/o/r.git");
  });
});

describe("runCheckCommand with --report", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "releaseproof-cli-report-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("writes pretty-printed JSON with a trailing newline, creates parent dirs, and keeps text on stdout", async () => {
    const dir = makeTempDir();
    const reportPath = path.join(dir, "nested", "sub", "report.json");
    const expected = fakeReport(1);
    const runCheck = vi.fn(async () => expected);
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { report: reportPath, quiet: true }, streams.io, {
      runCheck,
    });

    expect(code).toBe(1);
    expect(streams.err).toEqual([]);
    expect(streams.out.join("")).toContain("Verdict: summary");
    const contents = readFileSync(reportPath, "utf8");
    expect(contents).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("writes the file and keeps JSON on stdout when combined with --json", async () => {
    const dir = makeTempDir();
    const reportPath = path.join(dir, "report.json");
    const expected = fakeReport(0);
    const runCheck = vi.fn(async () => expected);
    const streams = io();

    const code = await runCheckCommand(
      "x@1.0.0",
      { json: true, report: reportPath, quiet: true },
      streams.io,
      { runCheck },
    );

    expect(code).toBe(0);
    expect(streams.err).toEqual([]);
    expect(streams.out.join("")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(readFileSync(reportPath, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it.each(["", "   ", "report\0.json"])(
    "rejects invalid --report path %j before running a check",
    async (report) => {
      const runCheck = vi.fn(async () => fakeReport(0));
      const streams = io();

      const code = await runCheckCommand("x@1.0.0", { report }, streams.io, { runCheck });

      expect(code).toBe(2);
      expect(runCheck).not.toHaveBeenCalled();
      expect(streams.out).toEqual([]);
      expect(streams.err).toEqual([
        `error: --report expects a file path, got ${JSON.stringify(report)}\n`,
      ]);
    },
  );

  it("exits 2 before running check with an error: line and no stack trace when --report is an existing directory", async () => {
    const dir = makeTempDir();
    const runCheck = vi.fn(async () => fakeReport(0));
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { report: dir, quiet: true }, streams.io, {
      runCheck,
    });

    expect(code).toBe(2);
    expect(runCheck).not.toHaveBeenCalled();
    expect(streams.out).toEqual([]);
    expect(streams.err).toHaveLength(1);
    expect(streams.err[0]).toMatch(/^error: could not write report to /);
    expect(streams.err[0]).not.toMatch(/^\s+at /m);
  });

  it("exits 2 before running check when a parent segment is a regular file, including single JSON error under --json", async () => {
    const dir = makeTempDir();
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "occupied", "utf8");
    const reportPath = path.join(blocker, "report.json");
    const runCheck = vi.fn(async () => fakeReport(0));
    const streams = io();

    const code = await runCheckCommand(
      "x@1.0.0",
      { json: true, report: reportPath, quiet: true },
      streams.io,
      { runCheck },
    );

    expect(code).toBe(2);
    expect(runCheck).not.toHaveBeenCalled();
    expect(streams.err).toHaveLength(1);
    expect(streams.err[0]).toMatch(/^error: could not write report to /);
    expect(streams.err[0]).not.toMatch(/^\s+at /m);
    const parsed = JSON.parse(streams.out.join("")) as { error?: { message: string } };
    expect(parsed.error?.message).toMatch(/^could not write report to /);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "exits 2 before running check when the target directory is not writable",
    async () => {
      const dir = makeTempDir();
      const readOnlyDir = path.join(dir, "locked");
      mkdirSync(readOnlyDir);
      chmodSync(readOnlyDir, 0o555);
      const reportPath = path.join(readOnlyDir, "report.json");
      const runCheck = vi.fn(async () => fakeReport(0));
      const streams = io();

      try {
        const code = await runCheckCommand(
          "x@1.0.0",
          { report: reportPath, quiet: true },
          streams.io,
          { runCheck },
        );

        expect(code).toBe(2);
        expect(runCheck).not.toHaveBeenCalled();
        expect(streams.out).toEqual([]);
        expect(streams.err).toHaveLength(1);
        expect(streams.err[0]).toMatch(/^error: could not write report to /);
        expect(streams.err[0]).not.toMatch(/^\s+at /m);
      } finally {
        chmodSync(readOnlyDir, 0o755);
      }
    },
  );

  it("overwrites an existing writable --report file", async () => {
    const dir = makeTempDir();
    const reportPath = path.join(dir, "report.json");
    writeFileSync(reportPath, '{"stale":true}\n', "utf8");
    const expected = fakeReport(0);
    const runCheck = vi.fn(async () => expected);
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { report: reportPath, quiet: true }, streams.io, {
      runCheck,
    });

    expect(code).toBe(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(readFileSync(reportPath, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("does not write --report when runCheck throws ToolError", async () => {
    const dir = makeTempDir();
    const reportPath = path.join(dir, "should-not-exist", "report.json");
    const runCheck = vi.fn(async () => {
      throw new ToolError("Docker is not available");
    });
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { report: reportPath }, streams.io, { runCheck });

    expect(code).toBe(2);
    expect(streams.out).toEqual([]);
    expect(streams.err).toEqual(["error: Docker is not available\n"]);
    expect(() => readFileSync(reportPath, "utf8")).toThrow();
  });
});

describe("runCheckCommand with --patch-lines", () => {
  function reportWithPatch(): CheckReport {
    const patch = [
      "--- rebuild/lib/index.js",
      "+++ release/lib/index.js",
      "@@ -1,8 +1,8 @@",
      "-const a = 1;",
      "+const a = 2;",
      " const b = 2;",
      " const c = 3;",
      " const d = 4;",
      " const e = 5;",
      " const f = 6;",
      " const g = 7;",
    ].join("\n");
    const base = fakeReport(1);
    return {
      ...base,
      verdict: {
        ...base.verdict,
        counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        findings: [
          {
            id: "file-changed",
            severity: "high",
            title: "1 file differs from the source",
            detail: "Not what a clean build produces.",
            paths: ["lib/index.js"],
            evidence: { patches: { "lib/index.js": patch } },
          },
        ],
      },
    };
  }

  it("shows at most 5 diff lines per file and then the more-lines footer for --patch-lines 5", async () => {
    const runCheck = vi.fn(async () => reportWithPatch());
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { patchLines: "5", quiet: true }, streams.io, {
      runCheck,
    });

    expect(code).toBe(1);
    const out = streams.out.join("");
    expect(out).toContain("            --- lib/index.js\n");
    expect(out).toContain("            @@ -1,8 +1,8 @@\n");
    expect(out).toContain("             const c = 3;\n");
    expect(out).not.toContain("             const d = 4;\n");
    expect(out).toContain("            … 4 more lines (see --json)\n");
  });

  it("shows no diff lines while naming each changed file for --patch-lines 0", async () => {
    const runCheck = vi.fn(async () => reportWithPatch());
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { patchLines: "0", quiet: true }, streams.io, {
      runCheck,
    });

    expect(code).toBe(1);
    const out = streams.out.join("");
    expect(out).toContain("            --- lib/index.js\n            … 9 lines (see --json)\n");
    expect(out).not.toContain("@@ -1,8 +1,8 @@");
    expect(out).not.toContain("const a");
  });

  it("shows the whole patch with no truncation line for a large --patch-lines value", async () => {
    const runCheck = vi.fn(async () => reportWithPatch());
    const streams = io();

    const code = await runCheckCommand("x@1.0.0", { patchLines: "500", quiet: true }, streams.io, {
      runCheck,
    });

    expect(code).toBe(1);
    const out = streams.out.join("");
    expect(out).toContain("             const g = 7;\n");
    expect(out).not.toContain("more lines");
    expect(out).not.toContain("see --json");
  });

  it.each(["", "   ", "-1", "1.5", "abc", "0x10", "1e2", "+5"])(
    "rejects invalid --patch-lines value %j before running a check",
    async (patchLines) => {
      const runCheck = vi.fn(async () => fakeReport(0));
      const streams = io();

      const code = await runCheckCommand("x@1.0.0", { patchLines }, streams.io, { runCheck });

      expect(code).toBe(2);
      expect(runCheck).not.toHaveBeenCalled();
      expect(streams.out).toEqual([]);
      expect(streams.err).toEqual([
        `error: --patch-lines expects a whole number 0 or more, got ${JSON.stringify(patchLines)}\n`,
      ]);
    },
  );
});
