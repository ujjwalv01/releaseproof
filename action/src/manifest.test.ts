import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = readFileSync(new URL("../../action.yml", import.meta.url), "utf8");

/** Read only the two-space keys immediately under the requested top-level section. */
function declaredNames(section: "inputs" | "outputs"): Set<string> {
  const names = new Set<string>();
  let current = "";
  for (const line of manifest.split(/\r?\n/)) {
    const heading = /^([\w-]+):/.exec(line);
    if (heading) current = heading[1] ?? "";
    if (current !== section) continue;
    const key = /^ {2}([\w-]+):/.exec(line);
    if (key) names.add(key[1] as string);
  }
  return names;
}

function calledNames(file: string, calls: RegExp): Set<string> {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return new Set([...source.matchAll(calls)].map((match) => match[2] as string));
}

function assertParity(section: "inputs" | "outputs", used: Set<string>): void {
  const declared = declaredNames(section);
  expect(used.size, `No ${section} found in the Action source`).toBeGreaterThan(0);
  const declaredOnly = [...declared].filter((name) => !used.has(name)).sort();
  const sourceOnly = [...used].filter((name) => !declared.has(name)).sort();
  expect(
    { declaredOnly, sourceOnly },
    `action.yml ${section} differ from the Action source: declared only [${declaredOnly.join(", ")}]; source only [${sourceOnly.join(", ")}]`,
  ).toEqual({ declaredOnly: [], sourceOnly: [] });
}

describe("Action manifest", () => {
  it("declares exactly the inputs read by inputs.ts", () => {
    assertParity(
      "inputs",
      calledNames(
        "inputs.ts",
        /\b(?:getInput|getBooleanInput|getMultilineInput)\(\s*(["'])([^"']+)\1/g,
      ),
    );
  });

  it("declares exactly the outputs set by main.ts", () => {
    assertParity("outputs", calledNames("main.ts", /\bsetOutput\(\s*(["'])([^"']+)\1/g));
  });
});
