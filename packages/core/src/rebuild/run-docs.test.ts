import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUTS } from "./run.js";

const design = new URL("../../../../docs/design-rebuild.md", import.meta.url);

describe("documented rebuild timeouts", () => {
  it.each(["clone", "install", "build"] as const)(
    "keeps the %s stage's documented minutes in sync with DEFAULT_TIMEOUTS",
    (stage) => {
      const markdown = readFileSync(design, "utf8");
      const row = new RegExp(`^\\| \`${stage}\` \\| (\\d+) minutes \\|\\r?$`, "m").exec(markdown);
      expect(row, `missing ${stage} timeout in docs/design-rebuild.md`).not.toBeNull();
      expect(Number(row?.[1]) * 60_000).toBe(DEFAULT_TIMEOUTS[`${stage}Ms`]);
    },
  );
});
