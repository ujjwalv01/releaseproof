import { describe, expect, it } from "vitest";
import { packFixture, rawTar } from "../../test/tarballs.js";
import { compareTarballs } from "./compare.js";
import { readTarball } from "./tarball.js";

async function compareFixtures(release: string, rebuild: string) {
  return compareTarballs(
    readTarball(await packFixture(release)),
    readTarball(await packFixture(rebuild)),
  );
}

describe("compareTarballs", () => {
  it("is silent for the clean package against itself", async () => {
    const result = await compareFixtures("clean", "clean");
    expect(result.matches).toBe(true);
    expect(result.identical).toEqual([
      "LICENSE",
      "README.md",
      "index.js",
      "lib/greet.js",
      "package.json",
    ]);
    expect(result.changed).toEqual([]);
    expect(result.release).toEqual({ files: 5, bytes: result.rebuild.bytes, prefix: "package" });
  });

  it("ignores timestamps, ownership, entry order and compression", async () => {
    const release = readTarball(await packFixture("clean"));
    const rebuild = readTarball(
      await packFixture("clean", {
        mtime: new Date(),
        portable: false,
        reverse: true,
        gzip: false,
      }),
    );
    const result = compareTarballs(release, rebuild);
    expect(result.matches).toBe(true);
    expect(result.changed).toEqual([]);
    // Non-portable packing keeps the filesystem's modes (0o666 on Windows), which land in info.
    expect(result.identical.length + result.info.length).toBe(5);
  });

  it("catches an added postinstall script with a readable patch", async () => {
    const result = await compareFixtures("attacked-postinstall", "clean");
    expect(result.matches).toBe(false);
    expect(result.onlyInRelease.map((e) => e.path)).toEqual(["lib/setup.js"]);
    expect(result.changed).toHaveLength(1);
    const [change] = result.changed;
    expect(change).toMatchObject({ path: "package.json", kind: "content" });
    expect(change?.patch).toContain('+    "postinstall": "node lib/setup.js"');
    expect(change?.release.text).toBe(true);
  });

  it("catches an added prepare script as the only content change", async () => {
    const result = await compareFixtures("attacked-lifecycle-script", "clean");
    expect(result.matches).toBe(false);
    expect(result.onlyInRelease).toEqual([]);
    expect(result.onlyInRebuild).toEqual([]);
    expect(result.changed.map((change) => [change.path, change.kind])).toEqual([
      ["package.json", "content"],
    ]);
    expect(result.changed[0]?.patch).toContain('+    "prepare":');
    expect(result.identical).toEqual(["LICENSE", "README.md", "index.js", "lib/greet.js"]);
  });

  it("catches a file that is not in the source", async () => {
    const result = await compareFixtures("attacked-extra-file", "clean");
    expect(result.matches).toBe(false);
    expect(result.onlyInRelease).toEqual([
      expect.objectContaining({ path: "lib/telemetry.js", kind: "file", text: true }),
    ]);
    expect(result.changed).toEqual([]);
  });

  it("catches modified content and shows exactly what changed", async () => {
    const result = await compareFixtures("attacked-modified", "clean");
    expect(result.matches).toBe(false);
    expect(result.changed.map((c) => [c.path, c.kind])).toEqual([["lib/greet.js", "content"]]);
    expect(result.changed[0]?.patch).toContain(
      '+  const beacon = "https://example.invalid/collect"; // added after the build',
    );
    expect(result.identical).toContain("index.js");
  });

  it("catches an added dependency", async () => {
    const result = await compareFixtures("attacked-dependency", "clean");
    expect(result.changed.map((c) => c.path)).toEqual(["package.json"]);
    expect(result.changed[0]?.patch).toContain('+    "left-pad": "^1.3.0"');
  });

  it("catches an added binary and knows it is not text", async () => {
    const result = await compareFixtures("attacked-binary", "clean");
    expect(result.onlyInRelease).toEqual([
      expect.objectContaining({ path: "build/Release/native.node", text: false, size: 20 }),
    ]);
  });

  it("labels line-ending-only changes as whitespace, with a patch", () => {
    const release = readTarball(
      rawTar([{ path: "package/a.js", content: "x = 1;\r\ny = 2;\r\n" }]),
    );
    const rebuild = readTarball(rawTar([{ path: "package/a.js", content: "x = 1;\ny = 2;\n" }]));
    const result = compareTarballs(release, rebuild);
    expect(result.matches).toBe(false);
    expect(result.changed[0]).toMatchObject({ path: "a.js", kind: "whitespace" });
    expect(result.changed[0]?.patch).toContain("--- rebuild/a.js");
  });

  it("reports binary content changes without a patch", () => {
    const release = readTarball(
      rawTar([{ path: "package/a.bin", content: Buffer.from([0, 1, 2]) }]),
    );
    const rebuild = readTarball(
      rawTar([{ path: "package/a.bin", content: Buffer.from([0, 1, 3]) }]),
    );
    const [change] = compareTarballs(release, rebuild).changed;
    expect(change).toMatchObject({ path: "a.bin", kind: "content", patch: undefined });
  });

  it("skips the patch above the size cap but still reports the change", () => {
    const big = "a".repeat(2000);
    const release = readTarball(rawTar([{ path: "package/big.txt", content: `${big}1` }]));
    const rebuild = readTarball(rawTar([{ path: "package/big.txt", content: `${big}2` }]));
    const [change] = compareTarballs(release, rebuild, { maxPatchBytes: 1000 }).changed;
    expect(change).toMatchObject({ path: "big.txt", kind: "content", patch: undefined });
  });

  it("treats permission bits as info, not as a difference", () => {
    const release = readTarball(
      rawTar([{ path: "package/cli.js", content: "#!/usr/bin/env node\n", mode: 0o755 }]),
    );
    const rebuild = readTarball(
      rawTar([{ path: "package/cli.js", content: "#!/usr/bin/env node\n", mode: 0o644 }]),
    );
    const result = compareTarballs(release, rebuild);
    expect(result.matches).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.info).toEqual([
      expect.objectContaining({
        path: "cli.js",
        kind: "mode",
        release: expect.objectContaining({ mode: 0o755, executable: true }),
        rebuild: expect.objectContaining({ mode: 0o644, executable: false }),
      }),
    ]);
  });

  it("reports a file replaced by a link as a type change, and the link as a problem", () => {
    const release = readTarball(
      rawTar([{ path: "package/a.js", type: "SymbolicLink", linkpath: "/etc/passwd" }]),
    );
    const rebuild = readTarball(rawTar([{ path: "package/a.js", content: "ok" }]));
    const result = compareTarballs(release, rebuild);
    expect(result.matches).toBe(false);
    expect(result.changed[0]).toMatchObject({ path: "a.js", kind: "type" });
    expect(result.problems.release).toEqual(['symlink "package/a.js" -> "/etc/passwd"']);
  });

  it("never matches when either archive had problems, even with identical files", () => {
    const release = readTarball(
      rawTar([
        { path: "package/a.js", content: "ok" },
        { path: "/abs", content: "x" },
      ]),
    );
    const rebuild = readTarball(rawTar([{ path: "package/a.js", content: "ok" }]));
    const result = compareTarballs(release, rebuild);
    expect(result.identical).toEqual(["a.js"]);
    expect(result.matches).toBe(false);
  });

  it("ignores directory entries, which carry nothing", () => {
    const release = readTarball(
      rawTar([
        { path: "package/lib", type: "Directory" },
        { path: "package/lib/a.js", content: "x" },
      ]),
    );
    const rebuild = readTarball(rawTar([{ path: "package/lib/a.js", content: "x" }]));
    expect(compareTarballs(release, rebuild).matches).toBe(true);
  });
});
