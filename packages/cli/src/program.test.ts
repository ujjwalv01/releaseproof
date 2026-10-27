import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { createProgram } from "./program.js";

function run(args: string[]): { output: string; exitCode: number | undefined } {
  let output = "";
  const program = createProgram()
    .exitOverride()
    .configureOutput({ writeOut: (s) => (output += s), writeErr: (s) => (output += s) });
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    return { output, exitCode: (error as { exitCode?: number }).exitCode };
  }
  return { output, exitCode: undefined };
}

describe("releaseproof CLI", () => {
  it.each(["--version", "-v"])("prints the package version for %s", (flag) => {
    const { output, exitCode } = run([flag]);
    expect(output.trim()).toBe(pkg.version);
    expect(exitCode).toBe(0);
  });

  it("documents --no-rekor in check --help", () => {
    const check = createProgram().commands.find((command) => command.name() === "check");
    expect(check?.helpInformation()).toContain("--no-rekor");
  });
});
