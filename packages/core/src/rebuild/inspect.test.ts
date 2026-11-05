import { describe, expect, it } from "vitest";
import { InspectionError, parseInspection } from "./inspect.js";
import { planBuild, REPO_DIR } from "./plan.js";
import { renderCommand } from "./scripts.js";

const commit = "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a";
const target = { name: "tiny", version: "1.0.0" };

function inspection(overrides: Record<string, unknown> = {}) {
  return parseInspection({ commit, packages: [{ dir: ".", ...target }], ...overrides });
}

// These are JSON values the clone stage can actually print, rather than functions or getters.
const nonObjects = [null, false, 5, "text", []];
const nonStrings = [null, false, 5, {}, []];

describe("parseInspection", () => {
  it("preserves a clean inspection with every declared field populated", () => {
    const clean = {
      commit,
      lockfiles: ["pnpm-lock.yaml"],
      lockfileDetails: { pnpm: "9.0", npm: 3, yarnBerry: true },
      nodeVersionFiles: { ".nvmrc": "22", ".node-version": "22", ".tool-versions": "nodejs 22" },
      hasYarnrcYml: true,
      hasPnpmWorkspace: true,
      hasLernaJson: true,
      hasSubmodules: true,
      workflow: "node-version: 22",
      packages: [
        {
          dir: "packages/tiny",
          ...target,
          private: false,
          scripts: { build: "tsc" },
          packageManager: "pnpm@10.4.1",
          publishConfig: { directory: "dist", access: "public" },
          engines: { node: ">=22" },
          hasWorkspaces: false,
          lockfiles: ["package-lock.json"],
        },
      ],
    };
    expect(parseInspection(clean)).toStrictEqual(clean);
  });

  it("validates the clone stage's JSON and rejects escaping package directories", () => {
    const parsed = parseInspection({
      commit,
      lockfiles: ["pnpm-lock.yaml", 5],
      lockfileDetails: { pnpm: "9.0" },
      nodeVersionFiles: { ".nvmrc": "22" },
      hasPnpmWorkspace: true,
      packages: [
        {
          dir: ".",
          name: "root",
          private: true,
          scripts: { build: "x", bad: 1 },
          hasWorkspaces: true,
        },
      ],
      workflow: "node-version: 22",
    });
    expect(parsed.lockfiles).toEqual(["pnpm-lock.yaml"]);
    expect(parsed.packages[0]?.scripts).toEqual({ build: "x" });
    expect(parsed.hasYarnrcYml).toBe(false);
    expect(() => parseInspection({ commit, packages: [{ dir: "../outside" }] })).toThrow(
      /not inside the repository/,
    );
    expect(() => parseInspection({ commit: "abc", packages: [] })).toThrow(/no commit/);
    expect(() => parseInspection("nope")).toThrow(/not an object/);
  });

  it.each(nonObjects)("rejects a non-object inspection: %j", (value) => {
    expect(() => parseInspection(value)).toThrow(InspectionError);
    expect(() => parseInspection(value)).toThrow("inspection is not an object");
  });

  it.each([undefined, ...nonStrings, "", "abc", "a".repeat(41), "G".repeat(40)])(
    "rejects a missing, mistyped or malformed commit: %j",
    (value) => {
      expect(() => inspection({ commit: value })).toThrow(InspectionError);
      expect(() => inspection({ commit: value })).toThrow("inspection has no commit");
    },
  );

  it.each([undefined, null, false, 5, "packages", {}])(
    "rejects a missing or non-array packages list: %j",
    (packages) => {
      expect(() => inspection({ packages })).toThrow("inspection has no packages list");
    },
  );

  it.each([...nonObjects, {}, { dir: 5 }, { dir: null }])(
    "rejects malformed package entries: %j",
    (pkg) => {
      expect(() => inspection({ packages: [pkg] })).toThrow(InspectionError);
      expect(() => inspection({ packages: [pkg] })).toThrow("package entry is malformed");
    },
  );

  it.each(["/etc", "//etc", "..", "../outside", "a/../../outside", "a/../b"])(
    "rejects absolute or parent-traversing POSIX directories: %j",
    (dir) => {
      expect(() => inspection({ packages: [{ dir }] })).toThrow(InspectionError);
      expect(() => inspection({ packages: [{ dir }] })).toThrow(/not inside the repository/);
    },
  );

  it.each(["", "..\\outside", "a\\..\\..", "C:\\outside"])(
    "currently preserves directory strings that are not POSIX traversal: %j",
    (dir) => {
      expect(inspection({ packages: [{ dir }] }).packages[0]?.dir).toBe(dir);
    },
  );

  it.each(["\0", "pkg\0suffix", "pkg/\0suffix"])(
    "rejects NUL before a package directory can reach a command cwd: %j",
    (dir) => {
      const makePlan = () =>
        planBuild({
          inspection: inspection({ packages: [{ dir, ...target }] }),
          target,
        });
      expect(makePlan).toThrow(InspectionError);
      expect(makePlan).toThrow(/package directory.*contains NUL/);
    },
  );

  it.each(["name", "version", "packageManager"] as const)("drops non-string package %s", (key) => {
    for (const value of nonStrings) {
      expect(inspection({ packages: [{ dir: ".", [key]: value }] }).packages[0]?.[key]).toBe(
        undefined,
      );
    }
  });

  it.each(["private", "hasWorkspaces"] as const)("drops non-boolean package %s", (key) => {
    for (const value of [null, 0, 1, "true", "false", {}, []]) {
      expect(inspection({ packages: [{ dir: ".", [key]: value }] }).packages[0]?.[key]).toBe(
        undefined,
      );
    }
    for (const value of [true, false]) {
      expect(inspection({ packages: [{ dir: ".", [key]: value }] }).packages[0]?.[key]).toBe(value);
    }
  });

  it.each(["scripts", "engines"] as const)("filters %s to string-valued object entries", (key) => {
    for (const value of nonObjects) {
      expect(inspection({ packages: [{ dir: ".", [key]: value }] }).packages[0]?.[key]).toBe(
        undefined,
      );
    }
    expect(
      inspection({
        packages: [
          {
            dir: ".",
            [key]: {
              valid: "22; echo example",
              empty: "",
              ...Object.fromEntries(nonStrings.map((value, index) => [`bad${index}`, value])),
            },
          },
        ],
      }).packages[0]?.[key],
    ).toEqual({ valid: "22; echo example", empty: "" });
  });

  it("drops non-object publishConfig but preserves its intentionally unknown-valued fields", () => {
    for (const publishConfig of nonObjects) {
      expect(
        inspection({ packages: [{ dir: ".", publishConfig }] }).packages[0]?.publishConfig,
      ).toBeUndefined();
    }
    for (const directory of nonStrings) {
      const publishConfig = { directory, access: false, nested: { extra: [1] } };
      const parsed = inspection({ packages: [{ dir: ".", ...target, publishConfig }] });
      expect(parsed.packages[0]?.publishConfig).toEqual(publishConfig);
      expect(planBuild({ inspection: parsed, target })).toMatchObject({
        ok: true,
        plan: { packDir: REPO_DIR, pack: { cwd: REPO_DIR } },
      });
    }
  });

  it("rejects NUL before publishConfig.directory can reach the pack cwd", () => {
    const makePlan = () =>
      planBuild({
        inspection: inspection({
          packages: [{ dir: ".", ...target, publishConfig: { directory: "dist\0suffix" } }],
        }),
        target,
      });
    expect(makePlan).toThrow(InspectionError);
    expect(makePlan).toThrow("publishConfig.directory contains NUL");
  });

  it("drops non-arrays and filters root and per-package lockfiles to strings", () => {
    for (const lockfiles of [null, false, 5, "yarn.lock", {}]) {
      const parsed = inspection({ lockfiles, packages: [{ dir: ".", lockfiles }] });
      expect(parsed.lockfiles).toEqual([]);
      expect(parsed.packages[0]?.lockfiles).toBeUndefined();
    }
    const lockfiles = ["pnpm-lock.yaml", ...nonStrings, "../literal", "pnpm-lock.yaml"];
    const parsed = inspection({ lockfiles, packages: [{ dir: ".", lockfiles }] });
    const expected = ["pnpm-lock.yaml", "../literal", "pnpm-lock.yaml"];
    expect(parsed.lockfiles).toEqual(expected);
    expect(parsed.packages[0]?.lockfiles).toEqual(expected);
  });

  it("drops mistyped lockfileDetails containers and members", () => {
    const empty = { pnpm: undefined, npm: undefined, yarnBerry: undefined };
    for (const lockfileDetails of nonObjects) {
      expect(inspection({ lockfileDetails }).lockfileDetails).toEqual(empty);
    }
    for (const value of nonStrings) {
      expect(inspection({ lockfileDetails: { pnpm: value } }).lockfileDetails.pnpm).toBeUndefined();
    }
    for (const value of [null, "3", false, {}, []]) {
      expect(inspection({ lockfileDetails: { npm: value } }).lockfileDetails.npm).toBeUndefined();
    }
    for (const value of [null, "true", 1, {}, []]) {
      expect(
        inspection({ lockfileDetails: { yarnBerry: value } }).lockfileDetails.yarnBerry,
      ).toBeUndefined();
    }
    expect(
      inspection({ lockfileDetails: { pnpm: "$(example)", npm: -1.5, yarnBerry: false } })
        .lockfileDetails,
    ).toEqual({ pnpm: "$(example)", npm: -1.5, yarnBerry: false });
  });

  it.each(["hasYarnrcYml", "hasPnpmWorkspace", "hasLernaJson", "hasSubmodules"] as const)(
    "normalizes %s using strict true equality",
    (key) => {
      for (const value of [undefined, null, false, 0, 1, "true", {}, []]) {
        expect(inspection({ [key]: value })[key]).toBe(false);
      }
      expect(inspection({ [key]: true })[key]).toBe(true);
    },
  );

  it("drops non-object nodeVersionFiles and non-string file contents", () => {
    for (const nodeVersionFiles of nonObjects) {
      expect(inspection({ nodeVersionFiles }).nodeVersionFiles).toEqual({});
    }
    expect(
      inspection({
        nodeVersionFiles: {
          ".nvmrc": 22,
          ".node-version": null,
          ".tool-versions": ["nodejs", "22"],
          other: "kept",
        },
      }).nodeVersionFiles,
    ).toEqual({ other: "kept" });
  });

  it.each([".nvmrc", ".node-version", ".tool-versions"])(
    "preserves hostile %s text while the planner derives only a numeric image tag",
    (file) => {
      for (const raw of [
        "22\0\u001b[31m",
        `22${" ".repeat(10_000)}`,
        "22; $(example) `example` & | < >",
      ]) {
        const contents = file === ".tool-versions" ? `nodejs ${raw}` : raw;
        const parsed = inspection({ nodeVersionFiles: { [file]: contents } });
        expect(parsed.nodeVersionFiles).toEqual({ [file]: contents });
        expect(planBuild({ inspection: parsed, target })).toMatchObject({
          ok: true,
          plan: { nodeMajor: 22, image: "node:22-bookworm", nodeSource: file },
        });
      }
    },
  );

  it("drops non-string workflows and preserves workflow text for the planner", () => {
    for (const workflow of nonStrings) {
      expect(inspection({ workflow }).workflow).toBeNull();
    }
    const workflow = "node-version: '22; $(example)'\n\u001b[31m";
    const parsed = inspection({ workflow });
    expect(parsed.workflow).toBe(workflow);
    expect(planBuild({ inspection: parsed, target })).toMatchObject({
      ok: true,
      plan: { nodeMajor: 22, image: "node:22-bookworm" },
    });
  });

  it("preserves duplicate directories and input order without deduplication", () => {
    const packages = [
      { dir: ".", name: "first" },
      { dir: ".", name: "second" },
    ];
    expect(inspection({ packages }).packages.map(({ dir, name }) => ({ dir, name }))).toEqual(
      packages,
    );
  });

  it("accepts a large package array and still validates its final entry", () => {
    const packages: unknown[] = Array.from({ length: 10_000 }, (_, index) => ({
      dir: `packages/p${index}`,
      name: `p${index}`,
    }));
    const parsed = inspection({ packages });
    expect(parsed.packages).toHaveLength(10_000);
    expect(parsed.packages[0]?.dir).toBe("packages/p0");
    expect(parsed.packages.at(-1)?.dir).toBe("packages/p9999");
    expect(() => inspection({ packages: [...packages, { dir: "../outside" }] })).toThrow(
      InspectionError,
    );
  });

  it("leaves shell-like directory names literal through planning and command rendering", () => {
    const dir = "pkg'; $(example) `example`";
    const parsed = inspection({ packages: [{ dir, ...target, scripts: { build: "example" } }] });
    const result = planBuild({ inspection: parsed, target });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.pack.cwd).toBe(`${REPO_DIR}/${dir}`);
    expect(renderCommand(result.plan.pack)).toBe(
      "cd '/work/repo/pkg'\\''; $(example) `example`' && 'npm' 'pack' '--pack-destination' '/work/out'",
    );
  });
});
