import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifiedProvenance } from "../../test/context.js";
import { packFixture } from "../../test/tarballs.js";
import { computeDigests } from "../fetch/digests.js";
import { type CheckDeps, type CheckReport, runCheck } from "./run.js";

const doc = new URL("../../../../docs/json-report.md", import.meta.url);
const sections = ["top-level", "package", "provenance", "source", "rebuild", "diff", "verdict"];

/** Only the first Field table under each report heading, not status/entry tables or examples. */
function documentedFields(markdown: string): Map<string, Set<string>> {
  const fields = new Map<string, Set<string>>();
  let section = "";
  let inTable = false;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    if (line.startsWith("#")) {
      section =
        line === "## Top-level fields" ? "top-level" : (/^### `([^`]+)`$/.exec(line)?.[1] ?? "");
      inTable = false;
    }
    if (!sections.includes(section)) continue;
    const first = line.split("|")[1]?.trim();
    if (line.startsWith("|") && first === "Field" && !fields.has(section)) {
      fields.set(section, new Set());
      inTable = true;
    } else if (!line.startsWith("|")) {
      inTable = false;
    } else if (inTable) {
      for (const match of (first ?? "").matchAll(/`([^`]+)`/g)) {
        fields.get(section)?.add(match[1] as string);
      }
    }
  }
  return fields;
}

function assertDocumented(fields: Map<string, string[]>, markdown: string): void {
  const docs = documentedFields(markdown);
  const missing = [...fields].flatMap(([section, keys]) =>
    keys.filter((key) => !docs.get(section)?.has(key)).map((key) => `${section}.${key}`),
  );
  expect(missing, `fields missing from docs/json-report.md: ${missing.join(", ")}`).toEqual([]);
}

describe("docs/json-report.md", () => {
  it("documents every field in a full runCheck report under its own heading", async () => {
    const tarball = await packFixture("attacked-postinstall");
    const deps: CheckDeps = {
      fetchPublished: async () => ({
        origin: { kind: "published", registry: "https://registry.npmjs.org/" },
        name: "@releaseproof/fixture",
        version: "1.0.0",
        purl: "pkg:npm/%40releaseproof/fixture@1.0.0",
        tarball,
        digests: computeDigests(tarball),
        dist: {},
        hints: {},
        attestations: null,
      }),
      fetchStaged: async () => {
        throw new Error("unexpected staged fetch");
      },
      fetchRegistryKeys: async () => [],
      verifyProvenance: async () => verifiedProvenance(),
      findRekorProvenance: async () => {
        throw new Error("unexpected Rekor lookup");
      },
      rebuildPackage: async (source) => ({
        status: "ok",
        source,
        stages: [],
        volume: "fixture",
        tarball: await packFixture("clean"),
        image: "node:22-bookworm",
        toolVersion: "npm 10.9.9",
      }),
    };
    const report = await runCheck({ spec: "@releaseproof/fixture@1.0.0" }, deps);
    expect(report.provenance.status).toBe("verified");
    expect(report.rebuild?.status).toBe("ok");
    expect(report.diff?.matches).toBe(false);
    const fields = new Map([["top-level", Object.keys(report)]]);
    for (const section of sections.slice(1)) {
      const object = report[section as keyof CheckReport];
      expect(object, `${section} must be present in the sample report`).toBeDefined();
      fields.set(section, Object.keys(object as object));
    }
    assertDocumented(fields, readFileSync(doc, "utf8"));
  });

  it("ignores other columns, later tables, prose, examples and unrelated headings", () => {
    const markdown = [
      "### `source`",
      "| Field | Meaning |",
      "| --- | --- |",
      "| `repository` | `commit` |",
      "",
      "Prose with `commit`.",
      "",
      "| Field | Meaning |",
      "| --- | --- |",
      "| `commit` | Nested entry |",
      "",
      "### `other`",
      "| Field | Meaning |",
      "| --- | --- |",
      "| `commit` | Wrong section |",
      "```md",
      "### `source`",
      "| Field | Meaning |",
      "| `commit` | Example |",
      "```",
    ].join("\r\n");
    expect(documentedFields(markdown)).toEqual(new Map([["source", new Set(["repository"])]]));
    expect(() => assertDocumented(new Map([["source", ["commit"]]]), markdown)).toThrow(
      "source.commit",
    );
  });

  it("allows documented optional fields absent from the sample", () => {
    assertDocumented(
      new Map([["source", ["repository"]]]),
      "### `source`\n| Field | Type |\n| --- | --- |\n| `repository` | string |\n| `ref` | optional |\n",
    );
  });
});
