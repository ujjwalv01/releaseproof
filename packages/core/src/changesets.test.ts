import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const changesetDir = path.join(root, ".changeset");
const validBumps = new Set(["major", "minor", "patch"]);

/** The directories listed in pnpm-workspace.yaml are `action` and `packages/*`. */
function workspacePackageNames(): Set<string> {
  const packageDirs = [
    path.join(root, "action"),
    ...readdirSync(path.join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, "packages", entry.name)),
  ];
  const names = new Set<string>();
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof manifest.name !== "string" || !manifest.name || names.has(manifest.name)) {
      throw new Error(`Missing or duplicate workspace package name in ${dir}`);
    }
    names.add(manifest.name);
  }
  return names;
}

function changesetProblems(file: string, source: string, packages: ReadonlySet<string>): string[] {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return [`${file}:1: missing opening ---`];

  const closing = lines.indexOf("---", 1);
  if (closing === -1) return [`${file}: missing closing ---`];

  const problems: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < closing; index++) {
    const line = lines[index] ?? "";
    if (/^\s*(?:#.*)?$/.test(line)) continue;

    // Changesets front matter is a YAML map of package names to release bumps.
    // The supported package-name syntax needs no YAML parser or new dependency.
    const match =
      /^\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9][a-z0-9._-]*))\s*:\s+(?:"([^"]+)"|'([^']+)'|([^\s'"#]+))(?:\s+#.*)?\s*$/.exec(
        line,
      );
    if (!match) {
      problems.push(`${file}:${index + 1}: malformed changeset entry`);
      continue;
    }

    const name = (match[1] ?? match[2] ?? match[3]) as string;
    const bump = (match[4] ?? match[5] ?? match[6]) as string;
    if (!packages.has(name)) {
      problems.push(`${file}:${index + 1}: unknown workspace package ${JSON.stringify(name)}`);
    }
    if (!validBumps.has(bump)) {
      problems.push(`${file}:${index + 1}: invalid release bump ${JSON.stringify(bump)}`);
    }
    if (seen.has(name)) {
      problems.push(`${file}:${index + 1}: duplicate package ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
  return problems;
}

function changesetFileProblems(
  files: readonly string[],
  readSource: (file: string) => string,
  packages: ReadonlySet<string>,
): string[] {
  return files
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .flatMap((file) => changesetProblems(`.changeset/${file}`, readSource(file), packages));
}

describe("changeset metadata", () => {
  const packages = workspacePackageNames();

  it("reads package names from the workspace manifests", () => {
    expect(packages.has("releaseproof")).toBe(true);
    expect(packages.has("@releaseproof/core")).toBe(true);
    expect(packages.has("@releaseproof/action")).toBe(true);
  });

  it("accepts valid package bumps, quoted keys, comments, and CRLF", () => {
    const source = [
      "---",
      '"releaseproof": patch',
      "'@releaseproof/core': minor # internal package",
      '"@releaseproof/action": major',
      "---",
      "Description",
    ].join("\r\n");
    expect(changesetProblems("valid.md", source, packages)).toEqual([]);
  });

  it("rejects the nonexistent @releaseproof/cli package from issue #150", () => {
    expect(
      changesetProblems("invalid.md", '---\n"@releaseproof/cli": patch\n---\n', packages),
    ).toEqual(['invalid.md:2: unknown workspace package "@releaseproof/cli"']);
  });

  it("rejects invalid bumps, malformed entries, and duplicate package keys", () => {
    expect(
      changesetProblems(
        "invalid.md",
        '---\n"releaseproof": hotfix\nnot yaml\n"releaseproof": patch\n---\n',
        packages,
      ),
    ).toEqual([
      'invalid.md:2: invalid release bump "hotfix"',
      "invalid.md:3: malformed changeset entry",
      'invalid.md:4: duplicate package "releaseproof"',
    ]);
  });

  it("rejects YAML lines without a space after the colon or before an inline comment", () => {
    expect(changesetProblems("bad.md", '---\n"releaseproof":patch\n---\n', packages)).toEqual([
      "bad.md:2: malformed changeset entry",
    ]);
    expect(
      changesetProblems("bad.md", '---\n"releaseproof": patch#other\n---\n', packages),
    ).toEqual(["bad.md:2: malformed changeset entry"]);
  });

  it("requires quoted package keys when YAML reserves their first character", () => {
    expect(
      changesetProblems("bad.md", "---\n@releaseproof/action: major\n---\n", packages),
    ).toEqual(["bad.md:2: malformed changeset entry"]);
  });

  it("rejects missing front matter delimiters", () => {
    expect(changesetProblems("bad.md", '"releaseproof": patch', packages)).toEqual([
      "bad.md:1: missing opening ---",
    ]);
    expect(changesetProblems("bad.md", '---\n"releaseproof": patch', packages)).toEqual([
      "bad.md: missing closing ---",
    ]);
  });

  it("does not require a changeset for documentation, tests, or CI changes", () => {
    const unexpectedRead = () => {
      throw new Error("README.md should not be read as a changeset");
    };
    expect(changesetFileProblems([], unexpectedRead, packages)).toEqual([]);
    expect(changesetFileProblems(["README.md"], unexpectedRead, packages)).toEqual([]);
  });

  it("fails a checked changeset file that names a nonexistent package", () => {
    expect(
      changesetFileProblems(
        ["README.md", "invalid.md", "config.json"],
        () => '---\n"@releaseproof/cli": patch\n---\n',
        packages,
      ),
    ).toEqual(['.changeset/invalid.md:2: unknown workspace package "@releaseproof/cli"']);
  });

  it("validates every checked-in changeset without requiring a git base branch", () => {
    const failures = changesetFileProblems(
      readdirSync(changesetDir),
      (file) => readFileSync(path.join(changesetDir, file), "utf8"),
      packages,
    );
    expect(failures, `Invalid changesets:\n${failures.join("\n")}`).toEqual([]);
  });
});
