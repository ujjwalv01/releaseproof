import { describe, expect, it } from "vitest";
import type { CheckReport } from "../check/run.js";
import { formatReport } from "./text.js";

const commit = "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a";

function report(overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    package: {
      name: "sigstore",
      version: "5.0.0",
      origin: "published",
      registry: "https://registry.npmjs.org/",
      sha512:
        "849a897e81bf7b8a8541a6ae40bd3473a27a16b1cb0462ad905bd6dc96d34881053a12eb4a375233f81677fc9439f628fe0b0445e8535c60b5559597fbd5f80e",
      files: 9,
    },
    provenance: {
      status: "verified",
      problems: [],
      warnings: [],
      mismatches: [],
      publishAttestation: { status: "verified" },
      source: {
        repository: "https://github.com/sigstore/sigstore-js",
        commit,
        ref: "refs/heads/main",
        workflowPath: ".github/workflows/release.yml",
        trigger: "push",
        runnerEnvironment: "github-hosted",
      },
    },
    source: { repository: "https://github.com/sigstore/sigstore-js", commit, verified: true },
    rebuild: {
      status: "ok",
      image: "node:22-bookworm",
      toolVersion: "npm 10.9.9",
      plan: {
        packageDir: "packages/client",
        manager: "npm",
        nodeMajor: 22,
        nodeSource: "default",
        buildSource: 'root "build" script',
        warnings: [],
      },
      stages: [],
      durationMs: 134_000,
    },
    diff: {
      matches: true,
      identical: 9,
      changed: [],
      onlyInRelease: [],
      onlyInRebuild: [],
      permissionDifferences: 0,
      problems: { release: [], rebuild: [] },
    },
    verdict: {
      status: "matches-source",
      exitCode: 0,
      summary: "MATCHES SOURCE: 9 files identical to a clean build of sigstore/sigstore-js@7d2900e",
      reasons: ["9 files identical to a clean build of sigstore/sigstore-js@7d2900e"],
      findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    durationMs: 150_000,
    ...overrides,
  };
}

describe("formatReport", () => {
  it.each(["ok", "failed"] as const)("shows the image digest for a %s rebuild", (status) => {
    const imageDigest = `node@sha256:${"0123456789abcdef".repeat(4)}`;
    const input = report({
      rebuild: { ...report().rebuild, status, stages: [], imageDigest, durationMs: 1_000 },
    });
    const text = formatReport(input);
    expect(text).toContain("             image digest node@sha256:0123456789abcdef…\n");
    expect(text).not.toContain(imageDigest);
    expect(input.rebuild?.imageDigest).toBe(imageDigest);
    expect(JSON.parse(JSON.stringify(input)).rebuild.imageDigest).toBe(imageDigest);
  });

  it("omits the digest when Docker did not provide one", () => {
    expect(formatReport(report())).not.toContain("image digest");
    expect(formatReport(report({ rebuild: undefined }))).not.toContain("image digest");
  });

  it("links the Rekor transparency log entry of a verified provenance", () => {
    const input = report();
    input.provenance.transparencyLog = { logIndex: "3310501741", integratedTime: "1792323552" };
    const text = formatReport(input);
    expect(text).toContain(
      "             log https://search.sigstore.dev/?logIndex=3310501741, integrated 2026-10-18T11:39:12.000Z\n",
    );
  });

  it("prints no log line without a transparency log entry or with a malformed index", () => {
    expect(formatReport(report())).not.toContain("search.sigstore.dev");
    const odd = report();
    odd.provenance.transparencyLog = { logIndex: "12 OR 1=1", integratedTime: "1792323552" };
    expect(formatReport(odd)).not.toContain("search.sigstore.dev");
    const noTime = report();
    noTime.provenance.transparencyLog = { logIndex: "7", integratedTime: "soon" };
    expect(formatReport(noTime)).toContain("log https://search.sigstore.dev/?logIndex=7\n");
  });

  it("prints a compact, readable report for a match", () => {
    const text = formatReport(report());
    expect(text).toBe(`releaseproof check sigstore@5.0.0

Package      sigstore@5.0.0 (registry.npmjs.org), 9 files, sha512 849a897e81bf…
Provenance   VERIFIED  sigstore/sigstore-js@7d2900e on refs/heads/main
             workflow .github/workflows/release.yml, trigger push, github-hosted runner
Rebuild      OK (2m 14s)  node:22-bookworm, npm 10.9.9, build: root "build" script
Files        9 identical, 0 changed, 0 only in release, 0 only in rebuild

Findings     none

Verdict: MATCHES SOURCE: 9 files identical to a clean build of sigstore/sigstore-js@7d2900e
`);
  });

  it("lists findings with paths and truncated patches, most severe first", () => {
    const patch = [
      "--- rebuild/lib/greet.js",
      "+++ release/lib/greet.js",
      "@@ -1,3 +1,4 @@",
      " a",
      "+  const beacon = 1;",
      " b",
    ].join("\n");
    const text = formatReport(
      report({
        diff: {
          matches: false,
          identical: 4,
          changed: [{ path: "lib/greet.js", kind: "content" }],
          onlyInRelease: [{ path: "lib/setup.js", size: 42 }],
          onlyInRebuild: [],
          permissionDifferences: 1,
          problems: { release: [], rebuild: [] },
        },
        verdict: {
          status: "differs-from-source",
          exitCode: 1,
          summary:
            "DIFFERS FROM SOURCE: files differ from a clean build of sigstore/sigstore-js@7d2900e: 1 changed, 1 only in the release",
          reasons: [
            "files differ…",
            "1 critical and 2 high finding(s): install-script-added, file-added, file-changed",
          ],
          counts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
          findings: [
            {
              id: "install-script-added",
              severity: "critical",
              title: 'install script added: "postinstall"',
              detail: "The release runs it on install.",
              paths: ["package.json"],
            },
            {
              id: "file-added",
              severity: "high",
              title: "1 file not produced by the source",
              detail: "In the release, not in a clean build.",
              paths: ["lib/setup.js"],
            },
            {
              id: "file-changed",
              severity: "high",
              title: "1 file differs from the source",
              detail: "Not what a clean build produces.",
              paths: ["lib/greet.js"],
              evidence: { patches: { "lib/greet.js": patch } },
            },
          ],
        },
      }),
      { maxPatchLines: 2 },
    );
    expect(text).toContain(
      "Files        4 identical, 1 changed, 1 only in release, 0 only in rebuild, 1 with different permissions (ignored)",
    );
    expect(text).toContain("Findings     3 (1 critical, 2 high)");
    expect(text).toContain(
      '  CRITICAL  install-script-added\n            install script added: "postinstall"\n            The release runs it on install.\n',
    );
    expect(text).toContain(
      "  HIGH      file-added\n            1 file not produced by the source\n            In the release, not in a clean build.\n              lib/setup.js\n",
    );
    expect(text).toContain(
      "            --- lib/greet.js\n            @@ -1,3 +1,4 @@\n             a\n            … 2 more lines (see --json)\n",
    );
    expect(text).toContain("\nVerdict: DIFFERS FROM SOURCE: files differ");
    expect(text).toContain("\n         1 critical and 2 high finding(s)");
  });

  it("explains a could-not-verify with the failing stage's output", () => {
    const text = formatReport(
      report({
        provenance: {
          status: "missing",
          problems: ["the registry has no attestations for this version"],
          warnings: [],
          mismatches: [],
          publishAttestation: { status: "missing" },
        },
        source: { repository: "https://github.com/o/r", commit: "b".repeat(40), verified: false },
        rebuild: {
          status: "failed",
          failure: "install stage exited with code 1",
          stages: [
            {
              stage: "install",
              image: "node:22-bookworm",
              network: "bridge",
              exitCode: 1,
              timedOut: false,
              durationMs: 5000,
              output: "npm ERR! code ERESOLVE\nnpm ERR! could not resolve",
            },
          ],
          durationMs: 9000,
        },
        diff: undefined,
        verdict: {
          status: "could-not-verify",
          exitCode: 2,
          summary: "COULD NOT VERIFY: the rebuild failed: install stage exited with code 1",
          reasons: ["the rebuild failed: install stage exited with code 1"],
          findings: [],
          counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
      }),
    );
    expect(text).toContain(
      "Provenance   MISSING  the registry has no attestations for this version",
    );
    expect(text).toContain(
      "Rebuild      FAILED (9s)  install stage exited with code 1\n             last output of the install stage:\n               npm ERR! code ERESOLVE\n               npm ERR! could not resolve\n",
    );
    expect(text).toContain("Files        9 in the release; nothing to compare with");
    expect(text).toContain("Verdict: COULD NOT VERIFY");
  });
});
