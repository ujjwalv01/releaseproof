import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Ignore fenced examples; keep original line numbers for diagnostics. */
function proseLines(markdown: string): { text: string; line: number }[] {
  let fence: { character: string; length: number } | undefined;
  return markdown.split(/\r?\n/).flatMap((text, index) => {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`).test(text)) {
        fence = undefined;
      }
      return [];
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (opening) {
      fence = { character: opening[0] as string, length: opening.length };
      return [];
    }
    return [{ text, line: index + 1 }];
  });
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const { text } of proseLines(markdown)) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(text)?.[1];
    if (!heading) continue;
    const base = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    let slug = base;
    for (let suffix = 1; slugs.has(slug); suffix++) slug = `${base}-${suffix}`;
    slugs.add(slug);
  }
  return slugs;
}

function relativeLinks(markdown: string): { target: string; line: number }[] {
  return proseLines(markdown).flatMap(({ text, line }) =>
    [
      ...text.matchAll(
        /\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g,
      ),
    ]
      .map((match) => ({ target: (match[1] ?? match[2]) as string, line }))
      .filter(({ target }) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)),
  );
}

function brokenLinks(file: string, markdown: string): string[] {
  const failures: string[] = [];
  for (const { target, line } of relativeLinks(markdown)) {
    const label = `${path.relative(root, file).replaceAll("\\", "/")}:${line}: ${target}`;
    try {
      const [rawFile = "", rawAnchor] = target.split("#", 2);
      const destination = rawFile
        ? path.resolve(path.dirname(file), decodeURIComponent(rawFile.split("?")[0] ?? ""))
        : file;
      if (!existsSync(destination)) {
        failures.push(`${label} (missing file)`);
      } else if (
        rawAnchor &&
        path.extname(destination).toLowerCase() === ".md" &&
        !headingSlugs(readFileSync(destination, "utf8")).has(decodeURIComponent(rawAnchor))
      ) {
        failures.push(`${label} (missing heading)`);
      }
    } catch (error) {
      failures.push(`${label} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return failures;
}

describe("documentation links", () => {
  it("checks every link when several quoted titles share a line", () => {
    expect(relativeLinks('[one](one.md "first") [two](two.md "second")')).toEqual([
      { target: "one.md", line: 1 },
      { target: "two.md", line: 1 },
    ]);
  });
  it("reads relative targets but ignores external links and fenced examples", () => {
    expect(
      relativeLinks(
        "[local](./rules.md#verdict)\n[web](https://example.com)\n```md\n[example](missing.md)\n```\n[mail](mailto:x@example.com)",
      ),
    ).toEqual([{ target: "./rules.md#verdict", line: 1 }]);
  });

  it("uses GitHub-style punctuation, code, and duplicate-heading slugs", () => {
    expect([
      ...headingSlugs(
        "## Hello, `World`!\n## Hello, World!\n## Does `--offline` work?\n~~~md\n## Not a heading\n~~~",
      ),
    ]).toEqual(["hello-world", "hello-world-1", "does---offline-work"]);
  });

  it("reports every broken file and heading with its source and target", () => {
    const source = path.join(root, "README.md");
    expect(
      brokenLinks(source, "[file](missing-doc.md)\n[anchor](docs/rules.md#missing-heading)"),
    ).toEqual([
      "README.md:1: missing-doc.md (missing file)",
      "README.md:2: docs/rules.md#missing-heading (missing heading)",
    ]);
  });

  it("resolves the root guides and every docs/*.md relative link and heading", () => {
    const files = [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      ...readdirSync(path.join(root, "docs"))
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => `docs/${file}`),
    ];
    const documents = files.map((file) => ({
      file: path.join(root, file),
      text: readFileSync(path.join(root, file), "utf8"),
    }));
    expect(documents.flatMap(({ text }) => relativeLinks(text)).length).toBeGreaterThan(0);
    const failures = documents.flatMap(({ file, text }) => brokenLinks(file, text));
    expect(failures, `Broken documentation links:\n${failures.join("\n")}`).toEqual([]);
  });
});
