import { type CheckOptions, type CheckReport, ToolError } from "@releaseproof/core";
import { describe, expect, it, vi } from "vitest";
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
  it.each(["4gb", "four", "-1g", "4g --privileged", "4g; echo unsafe", "4g\0", "4\n2g"])(
    "rejects %j before running a check",
    async (memory) => {
      const runCheck = vi.fn(async () => fakeReport(0));
      const streams = io();
      expect(await runCheckCommand("x@1.0.0", { memory }, streams.io, { runCheck })).toBe(2);
      expect(runCheck).not.toHaveBeenCalled();
      expect(streams.out).toEqual([]);
      expect(streams.err).toEqual([
        `error: --memory must be a Docker size such as 4g or 6144m, got "${memory}"\n`,
      ]);
    },
  );

  it.each([
    ["4g", "4g"],
    ["6144m", "6144m"],
    ["512", "512"],
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
