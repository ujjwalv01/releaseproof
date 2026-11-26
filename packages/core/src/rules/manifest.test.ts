import { describe, expect, it } from "vitest";
import { ruleContext } from "../../test/context.js";
import { rawTar } from "../../test/tarballs.js";
import { readTarball } from "../diff/tarball.js";
import { manifestRules, readManifest } from "./manifest.js";

function tarballWithManifest(manifest: unknown) {
  const content = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
  return readTarball(rawTar([{ path: "package/package.json", content }]));
}

const base = {
  name: "x",
  version: "1.0.0",
  main: "index.js",
  scripts: { test: "vitest" },
  dependencies: { a: "^1.0.0" },
};

function findings(release: unknown, rebuild: unknown) {
  return manifestRules(ruleContext(tarballWithManifest(release), tarballWithManifest(rebuild))).map(
    (f) => `${f.severity}:${f.id}`,
  );
}

describe("readManifest", () => {
  it("reports missing, oversized and invalid package.json", () => {
    expect(readManifest(readTarball(rawTar([{ path: "package/index.js", content: "" }])))).toEqual({
      ok: false,
      problem: "package.json is missing",
    });
    expect(readManifest(tarballWithManifest("{not json"))).toEqual({
      ok: false,
      problem: "package.json is not valid JSON",
    });
    expect(readManifest(tarballWithManifest("[]"))).toEqual({
      ok: false,
      problem: "package.json is not an object",
    });
  });
});

describe("manifestRules", () => {
  it("is silent when the manifests are equal", () => {
    expect(findings(base, base)).toEqual([]);
  });

  it("flags an unreadable release manifest as critical and stops", () => {
    expect(findings("{broken", base)).toEqual(["critical:manifest-unreadable"]);
  });

  it("flags changed install scripts as critical and other lifecycle scripts as high", () => {
    expect(findings({ ...base, scripts: { postinstall: "node x.js" } }, base)).toEqual([
      "critical:install-script-added",
      "low:script-changed",
    ]);
    expect(
      findings(
        { ...base, scripts: { test: "vitest", preinstall: "b" } },
        { ...base, scripts: { test: "vitest", preinstall: "a" } },
      ),
    ).toEqual(["critical:install-script-changed"]);
    expect(findings({ ...base, scripts: { test: "vitest", prepare: "husky" } }, base)).toEqual([
      "high:lifecycle-script-added",
    ]);
    expect(
      findings(
        { ...base, scripts: { test: "vitest", prepack: "b" } },
        { ...base, scripts: { test: "vitest", prepack: "a" } },
      ),
    ).toEqual(["high:lifecycle-script-changed"]);
  });

  it("grades dependency changes: added high, range changed medium, removed low", () => {
    expect(findings({ ...base, dependencies: { a: "^1.0.0", b: "1.0.0" } }, base)).toEqual([
      "high:dependency-added",
    ]);
    expect(findings({ ...base, dependencies: { a: "^2.0.0" } }, base)).toEqual([
      "medium:dependency-changed",
    ]);
    expect(findings({ ...base, dependencies: { a: "*" } }, base)).toEqual([
      "medium:dependency-changed",
    ]);
    expect(findings({ ...base, dependencies: {} }, base)).toEqual(["low:dependency-removed"]);
    expect(findings({ ...base, optionalDependencies: { c: "*" } }, base)).toEqual([
      "high:dependency-added",
    ]);
    expect(findings({ ...base, bundleDependencies: ["a"] }, base)).toEqual([
      "high:dependency-added",
    ]);
  });

  it("raises dependency-changed to high when a registry range is repointed to a non-registry spec or alias", () => {
    const nonRegistrySpecs = [
      "git+https://github.com/someone/lodash.git",
      "git://github.com/someone/lodash.git",
      "git@github.com:someone/lodash.git",
      "github:someone/lodash",
      "gitlab:someone/lodash",
      "bitbucket:someone/lodash",
      "gist:1234567890abcdef",
      "https://example.com/lodash-4.17.21.tgz",
      "http://example.com/lodash-4.17.21.tgz",
      "npm:lodash-fork@4.17.21",
      "file:../vendor/lodash",
      "link:../vendor/lodash",
      "someone/lodash",
      "someone/lodash#main",
    ];
    for (const spec of nonRegistrySpecs) {
      const result = manifestRules(
        ruleContext(
          tarballWithManifest({ ...base, dependencies: { a: spec } }),
          tarballWithManifest(base),
        ),
      );
      expect(result.map((f) => `${f.severity}:${f.id}`)).toEqual(["high:dependency-changed"]);
      expect(result[0]?.detail).toContain("non-registry URL, local path or package alias");
    }

    expect(
      findings(
        { ...base, dependencies: { a: "git+https://github.com/someone/lodash.git#v2" } },
        { ...base, dependencies: { a: "git+https://github.com/someone/lodash.git#v1" } },
      ),
    ).toEqual(["medium:dependency-changed"]);
  });

  it("flags changed entry points as high and other field changes as medium", () => {
    expect(findings({ ...base, main: "lib/evil.js" }, base)).toEqual(["high:entry-point-changed"]);
    expect(findings({ ...base, bin: { x: "./cli.js" } }, base)).toEqual([
      "high:entry-point-changed",
    ]);
    expect(findings({ ...base, exports: { ".": "./index.js" } }, base)).toEqual([
      "high:entry-point-changed",
    ]);
    const changed = manifestRules(
      ruleContext(
        tarballWithManifest({ ...base, version: "1.0.1", description: "x" }),
        tarballWithManifest(base),
      ),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      id: "manifest-field-changed",
      severity: "medium",
      title: "package.json fields differ: description, version",
    });
  });

  it("reports install scripts as medium when there is nothing to compare with", () => {
    const context = ruleContext(
      tarballWithManifest({ ...base, scripts: { postinstall: "x" } }),
      undefined,
    );
    expect(manifestRules(context).map((f) => `${f.severity}:${f.id}`)).toEqual([
      "medium:install-script-present",
    ]);
  });
});

describe("manifest-formatting-changed", () => {
  it("explains a byte difference when the JSON content is equal", () => {
    expect(findings(JSON.stringify(base), base)).toEqual(["low:manifest-formatting-changed"]);
    const reordered = {
      dependencies: base.dependencies,
      scripts: base.scripts,
      main: base.main,
      version: base.version,
      name: base.name,
    };
    expect(findings(reordered, base)).toEqual(["low:manifest-formatting-changed"]);
  });
});
