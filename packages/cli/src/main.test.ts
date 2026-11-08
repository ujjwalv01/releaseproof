import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("CLI exit status", () => {
  it.each([
    { args: ["check", "--bogus", "x@1.0.0"], status: 2 },
    { args: ["check", "--node"], status: 2 },
    { args: ["bogus-command"], status: 2 },
    { args: ["--help"], status: 0 },
    { args: ["check", "--help"], status: 0 },
    { args: ["--version"], status: 0 },
  ])("exits $status for $args", async ({ args, status }) => {
    process.argv = ["node", "releaseproof", ...args];
    process.exitCode = undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("Commander exited before the CLI could handle the result");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    vi.resetModules();
    await import("./main.js");

    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(status);
    if (status === 0) {
      expect(stdout).toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } else {
      expect(stderr).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^error:/));
    }
  });
});
