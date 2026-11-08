import { readFileSync } from "node:fs";
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
  it("describes --offline as a trust-root cache preference in check --help", () => {
    const check = createProgram().commands.find((command) => command.name() === "check");
    const help = check?.helpInformation().replace(/\s+/g, " ");
    expect(help).toContain(
      "prefer the cached Sigstore trust root (still fetched when missing or expired)",
    );
    expect(help).toContain(
      "registry, GitHub, Docker, dependencies and Rekor may still use network",
    );
  });

  it.each(["--version", "-v"])("prints the package version for %s", (flag) => {
    const { output, exitCode } = run([flag]);
    expect(output.trim()).toBe(pkg.version);
    expect(exitCode).toBe(0);
  });

  it("lists the exit codes in check --help", () => {
    const check = createProgram().commands.find((command) => command.name() === "check");
    let output = "";
    check?.configureOutput({ writeOut: (s) => (output += s) }).outputHelp();
    expect(output).toContain("Exit codes:");
    expect(output).toMatch(/^ {2}0 {2}MATCHES SOURCE/m);
    expect(output).toMatch(/^ {2}1 {2}DIFFERS FROM SOURCE/m);
    expect(output).toMatch(/^ {2}2 {2}COULD NOT VERIFY, or a tool error/m);
  });

  it("documents --no-rekor in check --help", () => {
    const check = createProgram().commands.find((command) => command.name() === "check");
    expect(check?.helpInformation()).toContain("--no-rekor");
  });

  it("documents every check option in README.md", () => {
    const check = createProgram().commands.find((command) => command.name() === "check");
    if (!check) throw new Error("check command is missing");
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const documented = new Set(readme.match(/--[a-z][a-z-]*/g));
    const missing = check.options
      .map((option) => option.long)
      .filter(
        (option) =>
          option !== undefined &&
          !["--help", "--version"].includes(option) &&
          !documented.has(option),
      );
    expect(missing, `README.md is missing check options: ${missing.join(", ")}`).toEqual([]);
  });
});
