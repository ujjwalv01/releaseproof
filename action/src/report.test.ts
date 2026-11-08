import { type CheckReport, countBySeverity, type Finding } from "@releaseproof/core";
import { describe, expect, it } from "vitest";
import { fenceFor, ISSUE_BODY_LIMIT, issueTitle, renderMarkdown, SUMMARY_LIMIT } from "./report.js";

function report(status: CheckReport["verdict"]["status"], exitCode: 0 | 1 | 2): CheckReport {
  return {
    package: {
      name: "x",
      version: "1.0.0",
      origin: "published",
      registry: "https://registry.npmjs.org/",
      sha512: "ab".repeat(32),
      files: 3,
    },
    provenance: {
      status: "missing",
      problems: [],
      warnings: [],
      mismatches: [],
      publishAttestation: { status: "missing" },
    },
    source: undefined,
    rebuild: undefined,
    diff: undefined,
    verdict: {
      status,
      exitCode,
      summary: `${status} summary`,
      reasons: [],
      findings:
        status === "matches-source"
          ? []
          : [{ id: "file-added", severity: "high", title: "t", detail: "d" }],
      counts: {
        critical: 0,
        high: status === "matches-source" ? 0 : 1,
        medium: 0,
        low: 0,
        info: 0,
      },
    },
    durationMs: 1,
  };
}

function withFindings(findings: Finding[]): CheckReport {
  const value = report("differs-from-source", 1);
  value.verdict.findings = findings;
  value.verdict.counts = countBySeverity(findings);
  return value;
}

function finding(id: string, severity: Finding["severity"]): Finding {
  return { id, severity, title: "title", detail: "detail" };
}

const RULES_URL = "https://github.com/ujjwalv01/releaseproof/blob/main/docs/rules.md";

/** The markdown with every fenced block removed: what GitHub renders as markdown. */
function outsideFences(md: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of md.split("\n")) {
    if (fence === undefined) {
      const open = /^(`{3,})text$/.exec(line);
      if (open) {
        fence = open[1];
      } else {
        kept.push(line);
      }
    } else if (line === fence) {
      fence = undefined;
    }
  }
  expect(fence, "every fence must be closed").toBeUndefined();
  return kept.join("\n");
}

/** Text a malicious archive could put into an entry path or link target. */
const HOSTILE =
  "```\n[click](https://evil.example) @someone ![](https://t.example/p.png) <img src=x>";

describe("fenceFor", () => {
  it("is always longer than any backtick run in the content", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("has ``` inside")).toBe("````");
    expect(fenceFor("has ````` five")).toBe("``````");
  });
});

describe("renderMarkdown", () => {
  it("puts the whole text report inside a code block with the verdict heading", () => {
    const md = renderMarkdown(
      report("differs-from-source", 1),
      "report text\n<img src=x onerror=alert(1)>\n",
      {
        runUrl: "https://github.com/o/r/actions/runs/1",
        reportPath: "releaseproof-report.json",
      },
    );
    expect(
      md.startsWith(
        `## 🚨 DIFFERS FROM SOURCE — \`x@1.0.0\`\n\n\`\`\`text\ndiffers-from-source summary\n\`\`\`\n\nFindings: 1 high\n\n- **high** [\`file-added\`](${RULES_URL})\n\n\`\`\`text\nreport text\n<img src=x onerror=alert(1)>\n\n\`\`\`\n`,
      ),
    ).toBe(true);
    expect(md).toContain("Workflow run: https://github.com/o/r/actions/runs/1");
    expect(md).toContain("Full JSON report: `releaseproof-report.json`");
  });

  it("widens the fence when the report contains backticks", () => {
    const md = renderMarkdown(report("matches-source", 0), "a ``` b");
    expect(md).toContain("````text\na ``` b\n````");
    expect(md).toContain("Findings: none");
  });

  it("truncates to the issue body limit and says so", () => {
    const huge = "x".repeat(ISSUE_BODY_LIMIT * 2);
    const md = renderMarkdown(report("could-not-verify", 2), huge);
    expect(md.length).toBeLessThanOrEqual(ISSUE_BODY_LIMIT);
    expect(md).toContain("… truncated; the JSON report has everything");
    expect(md.trimEnd().endsWith('"safe".')).toBe(true);
  });

  it("links distinct findings in severity then id order without mutating them", () => {
    const value = withFindings([
      finding("rebuild-note", "info"),
      finding("file-changed", "high"),
      finding("version-not-in-source", "low"),
      finding("file-added", "high"),
      finding("install-script-added", "critical"),
      finding("file-missing", "medium"),
    ]);
    const original = structuredClone(value.verdict.findings);
    const md = renderMarkdown(value, "report");
    expect(md.match(/^- .*$/gm)).toEqual([
      `- **critical** [\`install-script-added\`](${RULES_URL})`,
      `- **high** [\`file-added\`](${RULES_URL})`,
      `- **high** [\`file-changed\`](${RULES_URL})`,
      `- **medium** [\`file-missing\`](${RULES_URL})`,
      `- **low** [\`version-not-in-source\`](${RULES_URL})`,
      `- **info** [\`rebuild-note\`](${RULES_URL})`,
    ]);
    expect(value.verdict.findings).toEqual(original);
  });

  it("counts duplicate ids once and shows their most severe occurrence", () => {
    const md = renderMarkdown(
      withFindings([
        finding("unexpected-path", "medium"),
        finding("file-added", "high"),
        finding("unexpected-path", "high"),
        finding("file-added", "high"),
        finding("unexpected-path", "medium"),
      ]),
      "report",
    );
    expect(md.match(/^- .*$/gm)).toEqual([
      `- **high** [\`file-added\`](${RULES_URL}) (2)`,
      `- **high** [\`unexpected-path\`](${RULES_URL}) (3)`,
    ]);
    expect(md).toContain("Findings: 3 high, 2 medium");
  });

  it("does not add a finding list for an empty report", () => {
    const md = renderMarkdown(report("matches-source", 0), "no findings");
    expect(md).toContain("Findings: none\n\n```text\nno findings\n```");
    expect(md).not.toContain(RULES_URL);
  });

  it("keeps package titles, details and paths in the widened text fence", () => {
    const untrusted = "```\n@someone [bad](https://example.com) <img src=x>";
    const value = withFindings([
      { ...finding("file-added", "high"), title: untrusted, detail: untrusted, paths: [untrusted] },
    ]);
    const md = renderMarkdown(value, untrusted);
    const prefix = md.split("````text\n")[0];
    expect(prefix).toContain(`- **high** [\`file-added\`](${RULES_URL})`);
    expect(prefix).not.toContain(untrusted);
    expect(prefix).not.toContain("@someone");
    expect(md).toContain(`\`\`\`\`text\n${untrusted}\n\`\`\`\``);
  });

  it("keeps a verdict summary quoting archive paths inside its own code block (#157)", () => {
    const value = report("could-not-verify", 2);
    value.verdict.summary = `COULD NOT VERIFY: the release tarball could not be read: symlink "${HOSTILE}" -> "${HOSTILE}"`;
    const md = renderMarkdown(value, "report text");
    const markdown = outsideFences(md);
    for (const needle of ["evil.example", "@someone", "t.example", "<img"]) {
      expect(markdown).not.toContain(needle);
    }
    expect(markdown).toContain("## ⚠️ COULD NOT VERIFY — `x@1.0.0`");
    expect(markdown).toContain("Findings: 1 high");
    expect(md).toContain(`\`\`\`\`text\n${value.verdict.summary}\n\`\`\`\``);
  });

  it("shortens a very long summary above the report and stays within the budget", () => {
    const value = report("could-not-verify", 2);
    value.verdict.summary = `${HOSTILE} ${"x".repeat(SUMMARY_LIMIT * 3)}`;
    const md = renderMarkdown(value, "report text", { maxChars: 2_500 });
    expect(md).toContain("… (shortened; the full summary is in the report below)");
    expect(md.length).toBeLessThanOrEqual(2_500);
    expect(outsideFences(md)).not.toContain("evil.example");
  });

  it.each([
    ["[click](https://evil.example)", "1.0.0"],
    ["@someone", "1.0.0"],
    ["x", "1.0.0 ![](https://t.example/p.png)"],
    ["x`y", "1.0.0"],
  ])("replaces a malformed package name or version %j@%j from the registry", (name, version) => {
    const value = report("differs-from-source", 1);
    value.package = { ...value.package, origin: "staged", name, version };
    const md = renderMarkdown(value, "report text");
    const markdown = outsideFences(md);
    expect(markdown).toContain(
      "## 🚨 DIFFERS FROM SOURCE — (package name not shown: the registry returned a malformed one)",
    );
    for (const needle of ["evil.example", "@someone", "t.example", "x`y"]) {
      expect(markdown).not.toContain(needle);
    }
    expect(issueTitle(value)).toBe(
      "releaseproof: (package name not shown: the registry returned a malformed one) DIFFERS FROM SOURCE",
    );
  });

  it("shows a valid scoped package name as inline code", () => {
    const value = report("matches-source", 0);
    value.package = { ...value.package, name: "@scope/pkg_name", version: "2.0.0-rc.1" };
    expect(renderMarkdown(value, "ok")).toContain(
      "## ✅ MATCHES SOURCE — `@scope/pkg_name@2.0.0-rc.1`\n",
    );
    expect(issueTitle(value)).toBe("releaseproof: @scope/pkg_name@2.0.0-rc.1 MATCHES SOURCE");
  });

  it("includes the finding list in a custom text truncation budget", () => {
    const md = renderMarkdown(report("differs-from-source", 1), "x".repeat(2_000), {
      maxChars: 500,
    });
    expect(md).toContain(`- **high** [\`file-added\`](${RULES_URL})`);
    expect(md).toContain("… truncated; the JSON report has everything");
    expect(md.length).toBeLessThanOrEqual(500);
  });

  it("truncates an oversized finding list at complete bullets within the budget", () => {
    const md = renderMarkdown(
      withFindings([
        finding("file-added", "high"),
        finding("file-changed", "high"),
        finding("entry-point-changed", "high"),
        finding("dependency-added", "high"),
        finding("binary-added", "high"),
        finding("minified-code-added", "high"),
      ]),
      "x".repeat(2_000),
      { maxChars: 700 },
    );
    expect(md).toContain("… finding list truncated; the JSON report has everything");
    expect(md.match(/^- .*$/gm)?.every((line) => line.endsWith(`](${RULES_URL})`))).toBe(true);
    expect(md.length).toBeLessThanOrEqual(700);
    expect(md.trimEnd().endsWith('"safe".')).toBe(true);
  });

  it.each([300, 400, 500, 700, 1_000, 1_500])(
    "keeps framing, links and long fenced content within a %i-character budget",
    (maxChars) => {
      const md = renderMarkdown(
        withFindings([
          finding("file-added", "high"),
          finding("file-changed", "high"),
          finding("file-missing", "medium"),
        ]),
        `${"`".repeat(8)}\n${"untrusted".repeat(1_000)}`,
        { maxChars },
      );
      expect(md.length).toBeLessThanOrEqual(maxChars);
      expect(md).toContain("`".repeat(9));
      expect(md).toContain("… truncated; the JSON report has everything");
      expect(md.trimEnd().endsWith('"safe".')).toBe(true);
    },
  );
});

describe("issueTitle", () => {
  it("names the package and the verdict", () => {
    expect(issueTitle(report("differs-from-source", 1))).toBe(
      "releaseproof: x@1.0.0 DIFFERS FROM SOURCE",
    );
    expect(issueTitle(report("could-not-verify", 2))).toBe(
      "releaseproof: x@1.0.0 COULD NOT VERIFY",
    );
  });
});
