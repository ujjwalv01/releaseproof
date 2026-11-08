import { describe, expect, it } from "vitest";
import { fixtureContext, ruleContext } from "../../test/context.js";
import { rawTar } from "../../test/tarballs.js";
import { readTarball } from "../diff/tarball.js";
import { buildVerdict } from "../verdict/verdict.js";
import { runRules } from "./index.js";
import type { Finding } from "./types.js";

function ids(findings: Finding[]): string[] {
  return findings.map((finding) => `${finding.severity}:${finding.id}`);
}

describe("runRules on the fixture packages", () => {
  it("is silent for the clean package built from a verified source", async () => {
    expect(runRules(await fixtureContext("clean"))).toEqual([]);
  });

  it("catches an added install script as critical, plus the file it runs", async () => {
    const findings = runRules(await fixtureContext("attacked-postinstall"));
    expect(ids(findings)).toEqual(["critical:install-script-added", "high:file-added"]);
    expect(findings[0]).toMatchObject({
      title: 'install script added: "postinstall"',
      evidence: { script: "postinstall", command: "node lib/setup.js" },
    });
    expect(findings[1]?.paths).toEqual(["lib/setup.js"]);
  });

  it("catches an added prepare script as high without an install finding", async () => {
    const findings = runRules(await fixtureContext("attacked-lifecycle-script"));
    expect(ids(findings)).toEqual(["high:lifecycle-script-added"]);
    expect(findings[0]).toMatchObject({
      title: 'lifecycle script added: "prepare"',
      paths: ["package.json"],
      evidence: { script: "prepare", command: "node -e \"console.log('prepare')\"" },
    });
    expect(findings.some((finding) => finding.id === "install-script-added")).toBe(false);
  });

  it("catches a file the source does not produce", async () => {
    const findings = runRules(await fixtureContext("attacked-extra-file"));
    expect(ids(findings)).toEqual(["high:file-added"]);
    expect(findings[0]?.paths).toEqual(["lib/telemetry.js"]);
  });

  it("catches modified content with the patch as evidence", async () => {
    const findings = runRules(await fixtureContext("attacked-modified"));
    expect(ids(findings)).toEqual(["high:file-changed"]);
    const patches = findings[0]?.evidence?.patches as Record<string, string>;
    expect(patches["lib/greet.js"]).toContain("+  const beacon");
  });

  it("catches an added dependency", async () => {
    const findings = runRules(await fixtureContext("attacked-dependency"));
    expect(ids(findings)).toEqual(["high:dependency-added"]);
    expect(findings[0]?.evidence).toEqual({
      field: "dependencies",
      name: "left-pad",
      range: "^1.3.0",
    });
  });

  it("catches a native addon the source does not produce as critical", async () => {
    const findings = runRules(await fixtureContext("attacked-binary"));
    expect(ids(findings)).toEqual(["critical:native-code-added", "high:file-added"]);
    expect(findings[0]?.paths).toEqual(["build/Release/native.node"]);
  });

  it("catches obfuscated code the source does not produce as critical", async () => {
    const findings = runRules(await fixtureContext("attacked-obfuscated"));
    expect(ids(findings)).toEqual(["critical:obfuscated-code-added", "high:file-added"]);
    expect(findings[0]?.detail).toContain("hex-named identifiers");
  });

  it("reports files the release lacks as medium", async () => {
    const findings = runRules(await fixtureContext("clean", "attacked-extra-file"));
    expect(ids(findings)).toEqual(["medium:file-missing"]);
    expect(findings[0]?.paths).toEqual(["lib/telemetry.js"]);
  });

  it("downgrades to 'present' findings when there is no rebuild to compare with", async () => {
    expect(ids(runRules(await fixtureContext("attacked-postinstall", null)))).toEqual([
      "medium:install-script-present",
    ]);
    expect(ids(runRules(await fixtureContext("attacked-binary", null)))).toEqual([
      "medium:native-code-present",
    ]);
    expect(runRules(await fixtureContext("clean", null))).toEqual([]);
  });

  it("keeps install scripts that match the source as info only", async () => {
    const findings = runRules(await fixtureContext("attacked-postinstall", "attacked-postinstall"));
    expect(ids(findings)).toEqual(["info:install-script-present"]);
  });
});

describe("file rules on crafted tarballs", () => {
  const clean = (files: Array<{ path: string; content?: string; mode?: number }>) =>
    readTarball(rawTar(files.map((f) => ({ ...f, path: `package/${f.path}` }))));

  const withEntryKind = (type: "File" | "Directory") =>
    readTarball(
      rawTar([
        { path: "package/package.json", content: "{}" },
        { path: "package/shared", type, ...(type === "File" ? { content: "ordinary file" } : {}) },
      ]),
    );

  it.each([
    ["File", "Directory", "file", "directory"],
    ["Directory", "File", "directory", "file"],
  ] as const)(
    "flags a %s release entry replacing a %s source entry",
    (releaseType, sourceType, releaseKind, sourceKind) => {
      const release = withEntryKind(releaseType);
      const rebuilt = withEntryKind(sourceType);
      const context = ruleContext(release, rebuilt);
      const findings = runRules(context);
      expect(findings.filter((finding) => finding.id === "file-type-changed")).toEqual([
        {
          id: "file-type-changed",
          severity: "critical",
          title: "file replaced by a different kind of entry",
          detail: `shared: ${releaseKind} in the release, ${sourceKind} in the source`,
          paths: ["shared"],
        },
      ]);
      const source = {
        repository: "https://github.com/ujjwalv01/releaseproof",
        commit: "a".repeat(40),
        verified: true,
      };
      const verdict = buildVerdict({
        artifact: {
          name: context.name,
          version: context.version,
          origin: { kind: "published", registry: "https://registry.npmjs.org/" },
          hints: {},
        },
        provenance: context.provenance,
        source,
        rebuild: { status: "ok", source, stages: [], volume: "test" },
        release,
        rebuilt,
        diff: context.diff,
        expectations: {},
      });
      expect(verdict.status).toBe("differs-from-source");
    },
  );

  it.each(["File", "Directory"] as const)("is silent for matching %s entry kinds", (kind) => {
    const tarball = withEntryKind(kind);
    expect(runRules(ruleContext(tarball, tarball))).toEqual([]);
  });

  it("flags unexpected paths: high when the source lacks them, medium when it has them too", () => {
    const withEditor = clean([
      { path: "package.json", content: "{}" },
      { path: ".vscode/tasks.json", content: "{}" },
      { path: ".claude/settings.json", content: "{}" },
    ]);
    const without = clean([{ path: "package.json", content: "{}" }]);
    const high = runRules(ruleContext(withEditor, without)).filter(
      (f) => f.id === "unexpected-path",
    );
    expect(high.map((f) => [f.severity, f.paths])).toEqual([
      ["high", [".claude/settings.json"]],
      ["high", [".vscode/tasks.json"]],
    ]);
    const medium = runRules(ruleContext(withEditor, withEditor)).filter(
      (f) => f.id === "unexpected-path",
    );
    expect(medium.map((f) => f.severity)).toEqual(["medium", "medium"]);
  });

  it.each([
    "server.key",
    "certs/server.pem",
    "certs/client.p12",
    "client.pfx",
    "certs/SERVER.KEY",
    "id_rsa",
    "nested/id_rsa",
    ".git-credentials",
    "nested/.git-credentials",
    ".netrc",
    "nested/.netrc",
    ".ssh/id_rsa",
    "nested/.ssh/id_rsa",
    ".aws/credentials",
    "nested/.aws/config",
    ".docker/config.json",
    "nested/.docker/config.json",
    ".kube/config",
    "nested/.kube/config",
  ])("flags credential-looking path %s even when the rebuild contains it", (path) => {
    const release = clean([{ path, content: "credential fixture" }]);
    const without = clean([{ path: "package.json", content: "{}" }]);
    for (const [rebuild, severity] of [
      [without, "high"],
      [release, "medium"],
      [undefined, "high"],
    ] as const) {
      const findings = runRules(ruleContext(release, rebuild)).filter(
        (finding) => finding.id === "unexpected-path",
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity, paths: [path] });
      expect(findings[0]?.detail).toContain("credential");
    }
  });

  it("does not flag similar names outside credential path boundaries", () => {
    const release = clean(
      [
        "lib/keyring.js",
        "lib/monkey",
        "server.key.js",
        "cert.pem.bak",
        "client.p12.txt",
        "id_rsa.pub",
        "not_id_rsa",
        ".git-credentials.example",
        "my.netrc",
        ".ssh-config/id_rsa.pub",
        ".awsome/config",
        ".kubernetes/config",
        ".docker/config.json.bak",
        ".docker/configuration.json",
        "docker/config.json",
      ].map((path) => ({ path, content: "ordinary fixture" })),
    );
    expect(
      runRules(ruleContext(release, release)).filter((finding) => finding.id === "unexpected-path"),
    ).toEqual([]);
  });

  it("flags tarball problems as critical even when files match", () => {
    const release = readTarball(
      rawTar([
        { path: "package/package.json", content: "{}" },
        { path: "package/evil", type: "SymbolicLink", linkpath: "/etc/passwd" },
      ]),
    );
    const rebuild = clean([{ path: "package.json", content: "{}" }]);
    const findings = runRules(ruleContext(release, rebuild));
    expect(findings.map((f) => f.id)).toContain("tarball-problem");
    expect(findings.find((f) => f.id === "tarball-problem")?.severity).toBe("critical");
  });

  const ESCAPE = "npm never produces links, absolute paths or traversal";
  const LIMIT = "Reading stopped at a size limit, so the rest of the archive was not examined";
  const tarballDetail = (bytes: Buffer, limits?: Parameters<typeof readTarball>[1]) =>
    runRules(ruleContext(readTarball(bytes, limits), undefined)).find(
      (f) => f.id === "tarball-problem",
    )?.detail;
  const files = (count: number, content = "x") =>
    Array.from({ length: count }, (_, i) => ({ path: `package/f${i}.js`, content }));
  const limits = {
    maxEntries: 20_000,
    maxTotalBytes: 512 * 1024 * 1024,
    maxFileBytesInMemory: 1024,
  };

  it("explains an entry-count limit without the link/traversal sentence", () => {
    const detail = tarballDetail(rawTar(files(5)), { ...limits, maxEntries: 3 });
    expect(detail).toContain("more than 3 entries; stopped reading");
    expect(detail).toContain(LIMIT);
    expect(detail).not.toContain(ESCAPE);
  });

  it("explains an unpacked-size limit the same way", () => {
    const detail = tarballDetail(rawTar(files(3, "y".repeat(100))), {
      ...limits,
      maxTotalBytes: 150,
    });
    expect(detail).toContain("unpacked size exceeds 150 bytes; stopped reading");
    expect(detail).toContain(LIMIT);
    expect(detail).not.toContain(ESCAPE);
  });

  it("keeps the link/traversal sentence for an escape problem", () => {
    const detail = tarballDetail(
      rawTar([
        { path: "package/package.json", content: "{}" },
        { path: "package/evil", type: "SymbolicLink", linkpath: "/etc/passwd" },
      ]),
    );
    expect(detail).toContain(ESCAPE);
    expect(detail).not.toContain(LIMIT);
  });

  it("gives both explanations when both kinds of problem occur", () => {
    const detail = tarballDetail(
      rawTar([
        { path: "package/evil", type: "SymbolicLink", linkpath: "/etc/passwd" },
        ...files(5),
      ]),
      { ...limits, maxEntries: 3 },
    );
    expect(detail).toContain(ESCAPE);
    expect(detail).toContain(LIMIT);
  });

  it("adds no explanation for problems of neither kind", () => {
    const detail = tarballDetail(
      rawTar([
        { path: "package/a.js", content: "1" },
        { path: "other/b.js", content: "2" },
      ]),
    );
    expect(detail).toBeDefined();
    expect(detail).not.toContain(ESCAPE);
    expect(detail).not.toContain(LIMIT);
  });

  it("is not fooled by an entry whose name looks like a limit message", () => {
    const detail = tarballDetail(
      rawTar([
        { path: "package/package.json", content: "{}" },
        { path: "package/x; stopped reading", type: "SymbolicLink", linkpath: "y" },
      ]),
    );
    expect(detail).toContain(ESCAPE);
    expect(detail).not.toContain(LIMIT);
  });

  it("labels whitespace-only changes low and binary additions high", () => {
    const release = clean([
      { path: "package.json", content: "{}" },
      { path: "a.js", content: "x = 1;\r\n" },
      { path: "blob.dat", content: "\u0000\u0001\u0002binary" },
    ]);
    const rebuild = clean([
      { path: "package.json", content: "{}" },
      { path: "a.js", content: "x = 1;\n" },
    ]);
    expect(ids(runRules(ruleContext(release, rebuild)))).toEqual([
      "high:binary-added",
      "high:file-added",
      "low:file-changed-whitespace",
    ]);
  });

  it("does not call images binaries, and ignores minified code the source also produces", () => {
    const minified = `${"var a=1;".repeat(400)}\n`;
    const release = clean([
      { path: "package.json", content: "{}" },
      { path: "logo.png", content: "\u0089PNG\u0000" },
      { path: "dist/index.min.js", content: minified },
    ]);
    const rebuild = clean([
      { path: "package.json", content: "{}" },
      { path: "dist/index.min.js", content: minified },
    ]);
    expect(ids(runRules(ruleContext(release, rebuild)))).toEqual(["high:file-added"]);
    const changed = clean([
      { path: "package.json", content: "{}" },
      { path: "dist/index.min.js", content: `${minified}x();` },
    ]);
    expect(ids(runRules(ruleContext(changed, rebuild)))).toEqual([
      "high:file-changed",
      "high:minified-code-added",
    ]);
  });
});

describe("source rules", () => {
  it("turns planner warnings into low or info findings", async () => {
    const findings = runRules(
      await fixtureContext("clean", "clean", {
        rebuildWarnings: [
          "repository has version 0.9.0 at this commit, the release is 1.0.0",
          "no lockfile found: dependency versions are not pinned, so the rebuild may drift",
          "repository uses git submodules; they are cloned at their recorded commits",
        ],
      }),
    );
    expect(ids(findings)).toEqual([
      "low:no-lockfile",
      "low:version-not-in-source",
      "info:rebuild-note",
    ]);
  });
});
