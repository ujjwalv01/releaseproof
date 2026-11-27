import { describe, expect, it } from "vitest";
import { ToolError } from "../errors.js";
import { parseSpec, toPurl } from "./spec.js";

describe("parseSpec", () => {
  it("parses an unscoped exact spec", () => {
    expect(parseSpec("sigstore@5.0.0")).toEqual({
      name: "sigstore",
      version: "5.0.0",
      purl: "pkg:npm/sigstore@5.0.0",
    });
  });

  it("parses a scoped spec and escapes only the scope marker in the purl", () => {
    expect(parseSpec("@sigstore/verify@4.1.2")).toEqual({
      name: "@sigstore/verify",
      version: "4.1.2",
      purl: "pkg:npm/%40sigstore/verify@4.1.2",
    });
  });

  it("preserves the case of legacy unscoped and scoped package names", () => {
    expect(parseSpec("JSONStream@1.3.5")).toEqual({
      name: "JSONStream",
      version: "1.3.5",
      purl: "pkg:npm/JSONStream@1.3.5",
    });
    expect(parseSpec("@Legacy/Package@1.0.0")).toEqual({
      name: "@Legacy/Package",
      version: "1.0.0",
      purl: "pkg:npm/%40Legacy/Package@1.0.0",
    });
  });

  it("accepts prerelease versions", () => {
    expect(parseSpec("pkg@1.0.0-beta.1")).toEqual({
      name: "pkg",
      version: "1.0.0-beta.1",
      purl: "pkg:npm/pkg@1.0.0-beta.1",
    });
  });

  it("strips a single leading v or = from the version", () => {
    expect(parseSpec("left-pad@v1.3.0")).toEqual({
      name: "left-pad",
      version: "1.3.0",
      purl: "pkg:npm/left-pad@1.3.0",
    });
    expect(parseSpec("left-pad@=1.3.0")).toEqual({
      name: "left-pad",
      version: "1.3.0",
      purl: "pkg:npm/left-pad@1.3.0",
    });
    expect(parseSpec("@scope/pkg@v1.2.3-rc.1")).toEqual({
      name: "@scope/pkg",
      version: "1.2.3-rc.1",
      purl: "pkg:npm/%40scope/pkg@1.2.3-rc.1",
    });
  });

  it.each(["pkg@1.2.3+build", "pkg@1.0.0-beta.1+build.5", "pkg@v1.2.3+build"])(
    "rejects build metadata in %j",
    (input) => {
      expect(() => parseSpec(input)).toThrow(/build metadata/);
    },
  );

  it.each(["sigstore", "@sigstore/verify", "sigstore@", "@5.0.0"])(
    "rejects %j without an exact version",
    (input) => {
      expect(() => parseSpec(input)).toThrow(ToolError);
    },
  );

  it.each(["express", "@scope/pkg", "JSONStream"])(
    "explains how to give a version for %j",
    (name) => {
      expect(() => parseSpec(name)).toThrow(
        new ToolError(
          `Give an exact version: ${name}@<version>, for example ${name}@1.2.3 (npm view ${name} version prints the latest)`,
        ),
      );
    },
  );

  it.each([
    ["bad name@1.0.0", 'Invalid package name "bad name"'],
    ["bad name", 'Expected <name>@<version>, got "bad name"'],
    ["express@latest", 'Expected an exact version such as 1.2.3, got "latest"'],
    ["express@", 'Expected an exact version such as 1.2.3, got ""'],
  ])("preserves the other parse error for %j", (input, message) => {
    expect(() => parseSpec(input)).toThrow(new ToolError(message));
  });

  it.each([
    "sigstore@^5.0.0",
    "sigstore@latest",
    "sigstore@5",
    "sigstore@5.0",
    "sigstore@vv5.0.0",
    "sigstore@==5.0.0",
  ])("rejects range or tag %j: a verdict must be about one tarball", (input) => {
    expect(() => parseSpec(input)).toThrow(/exact version/);
  });

  it.each([
    ".hidden@1.0.0",
    "_Hidden@1.0.0",
    "..@1.0.0",
    "bad name@1.0.0",
    "@scope@1.0.0",
    "a/b@1.0.0",
    "@.Scope/Package@1.0.0",
    "@Scope/.Package@1.0.0",
    "@Scope/_Package@1.0.0",
    "Bad%2FName@1.0.0",
    `${"A".repeat(215)}@1.0.0`,
  ])("rejects invalid package name in %j", (input) => {
    expect(() => parseSpec(input)).toThrow(/Invalid package name/);
  });
});

describe("toPurl", () => {
  it("matches npm-package-arg's encoding", () => {
    expect(toPurl("sigstore", "5.0.0")).toBe("pkg:npm/sigstore@5.0.0");
    expect(toPurl("@types/node", "22.0.0")).toBe("pkg:npm/%40types/node@22.0.0");
  });
});
