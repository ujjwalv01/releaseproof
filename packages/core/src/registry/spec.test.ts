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

  it("accepts prerelease and build metadata", () => {
    expect(parseSpec("pkg@1.0.0-beta.1+build.5").version).toBe("1.0.0-beta.1+build.5");
  });

  it.each(["sigstore", "@sigstore/verify", "sigstore@", "@5.0.0"])(
    "rejects %j without an exact version",
    (input) => {
      expect(() => parseSpec(input)).toThrow(ToolError);
    },
  );

  it.each(["express", "@scope/pkg"])("explains how to give a version for %j", (name) => {
    expect(() => parseSpec(name)).toThrow(
      new ToolError(
        `Give an exact version: ${name}@<version>, for example ${name}@1.2.3 (npm view ${name} version prints the latest)`,
      ),
    );
  });

  it.each([
    ["bad name@1.0.0", 'Invalid package name "bad name"'],
    ["bad name", 'Expected <name>@<version>, got "bad name"'],
    ["express@latest", 'Expected an exact version such as 1.2.3, got "latest"'],
    ["express@", 'Expected an exact version such as 1.2.3, got ""'],
  ])("preserves the other parse error for %j", (input, message) => {
    expect(() => parseSpec(input)).toThrow(new ToolError(message));
  });

  it.each(["sigstore@^5.0.0", "sigstore@latest", "sigstore@5", "sigstore@5.0", "sigstore@v5.0.0"])(
    "rejects range or tag %j: a verdict must be about one tarball",
    (input) => {
      expect(() => parseSpec(input)).toThrow(/exact version/);
    },
  );

  it.each(["Sigstore@1.0.0", ".hidden@1.0.0", "bad name@1.0.0", "@scope@1.0.0", "a/b@1.0.0"])(
    "rejects invalid package name in %j",
    (input) => {
      expect(() => parseSpec(input)).toThrow(/Invalid package name/);
    },
  );
});

describe("toPurl", () => {
  it("matches npm-package-arg's encoding", () => {
    expect(toPurl("sigstore", "5.0.0")).toBe("pkg:npm/sigstore@5.0.0");
    expect(toPurl("@types/node", "22.0.0")).toBe("pkg:npm/%40types/node@22.0.0");
  });
});
