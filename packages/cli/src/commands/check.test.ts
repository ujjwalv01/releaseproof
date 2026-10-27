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
