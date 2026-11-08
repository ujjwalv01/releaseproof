import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = new URL("../../../.github/workflows/", import.meta.url);

/** Scan ordinary uses: lines without introducing a YAML parser dependency. */
function actionReferences(source: string): { line: number; value: string }[] {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:\s*(.*)$/.exec(line);
    if (!match) return [];
    const raw = (match[1] ?? "").trim();
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw);
    const value = quoted ? (quoted[2] ?? "") : (raw.split(/\s+#/)[0] ?? "").trim();
    return [{ line: index + 1, value }];
  });
}

function isPinned(value: string): boolean {
  return (
    value.startsWith("./") ||
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[a-f0-9]{40}$/.test(value) ||
    /^docker:\/\/[^\s@]+@sha256:[a-f0-9]{64}$/.test(value)
  );
}

function unpinnedReferences(file: string, source: string): string[] {
  return actionReferences(source)
    .filter(({ value }) => !isPinned(value))
    .map(({ line, value }) => `${file}:${line}: ${value}`);
}

describe("workflow action pins", () => {
  const sha = "a".repeat(40);

  it.each([
    "./",
    "./.github/actions/test",
    `actions/checkout@${sha}`,
    `owner/repo/path/to/action@${sha}`,
    `owner/repo/.github/workflows/ci.yml@${sha}`,
    `docker://alpine@sha256:${"a".repeat(64)}`,
  ])("accepts immutable or local reference %s", (reference) => {
    expect(isPinned(reference)).toBe(true);
  });

  it.each([
    "actions/checkout@v7",
    "actions/checkout@main",
    "actions/checkout@abcdef0",
    `actions/checkout@${"A".repeat(40)}`,
    `actions/checkout@${"a".repeat(39)}`,
    `actions/checkout@${"a".repeat(41)}`,
    "docker://alpine:3.21",
    "docker://alpine",
    "",
  ])("rejects unpinned reference %s", (reference) => {
    expect(isPinned(reference)).toBe(false);
  });

  it("handles comments, quoted values, CRLF, and job-level uses", () => {
    const source = [
      "# - uses: actions/checkout@main",
      `    - uses: actions/checkout@${sha} # v7`,
      `    - uses: 'owner/repo/action@${sha}' # version comment`,
      `    uses: "owner/repo/.github/workflows/ci.yml@${sha}"`,
      "    - uses: './local#action'",
      "    - run: echo uses: actions/checkout@main",
    ].join("\r\n");
    expect(actionReferences(source)).toHaveLength(4);
    expect(unpinnedReferences("example.yml", source)).toEqual([]);
  });

  it("reports the file, line, and offending value", () => {
    expect(
      unpinnedReferences(
        ".github/workflows/example.yaml",
        "steps:\n  - uses: actions/checkout@v7 # tag\n",
      ),
    ).toEqual([".github/workflows/example.yaml:2: actions/checkout@v7"]);
    expect(unpinnedReferences("example.yml", `uses: "actions/checkout@${sha}" junk`)).toHaveLength(
      1,
    );
  });

  it("pins every third-party action in checked-in workflows", () => {
    const files = readdirSync(workflows)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const failures = files.flatMap((file) =>
      unpinnedReferences(
        `.github/workflows/${file}`,
        readFileSync(new URL(file, workflows), "utf8"),
      ),
    );
    expect(failures, `Unpinned workflow actions:\n${failures.join("\n")}`).toEqual([]);
  });
});
