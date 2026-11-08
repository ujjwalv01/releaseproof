import type { FileChange, PathEntry } from "../diff/compare.js";
import type { TarballContents, TarEntry } from "../diff/tarball.js";
import { analyzeCode, isCodePath } from "./code.js";
import type { Finding, RuleContext } from "./types.js";

const UNEXPECTED_PATHS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^\.github\//,
    why: "GitHub workflow or config files have no place in a published package",
  },
  { pattern: /^\.vscode\//, why: "editor settings can run tasks when the folder is opened" },
  { pattern: /^\.idea\//, why: "editor settings can run tasks when the folder is opened" },
  {
    pattern: /^\.(claude|cursor|windsurf|aider|codex)(\/|rules$|\.md$)/,
    why: "instructions for AI coding tools can steer them into running commands",
  },
  {
    pattern: /^(CLAUDE|AGENTS|GEMINI|COPILOT)\.md$/i,
    why: "instructions for AI coding tools can steer them into running commands",
  },
  { pattern: /^\.git\//, why: "a .git directory inside a package is never intentional" },
  {
    pattern: /^\.(env|npmrc|yarnrc|yarnrc\.yml)$/,
    why: "config files that can carry credentials or change how tools behave",
  },
  { pattern: /^\.husky\//, why: "git hooks run commands" },
  {
    pattern:
      /\.(pem|key|p12|pfx)$|(^|\/)(id_rsa|\.git-credentials|\.netrc)$|(^|\/)\.(ssh|aws|kube)\/|(^|\/)\.docker\/config\.json$/i,
    why: "private keys and credential files must never ship in a package",
  },
];

const NATIVE_PATTERNS = /(^|\/)binding\.gyp$|\.(node|so|dll|dylib|exe|a|lib)$/i;
const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "pdf",
  "mp3",
  "mp4",
  "wav",
  "ogg",
]);

function extension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function describe(entry: PathEntry | TarEntry): string {
  const text = "text" in entry ? entry.text : entry.content ? undefined : undefined;
  return `${entry.size} bytes${text === true ? ", text" : text === false ? ", binary" : ""}`;
}

function patches(changes: FileChange[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const change of changes) {
    if (change.patch) {
      out[change.path] = change.patch;
    }
  }
  return out;
}

/**
 * Link / absolute / `..` problems that can escape the install directory. The prefixes are
 * written by `readTarball` itself; the entry path only ever comes after them.
 */
function isTarballEscapeProblem(problem: string): boolean {
  return (
    problem.startsWith("absolute path ") ||
    problem.startsWith("path traversal ") ||
    problem.startsWith("symlink ") ||
    problem.startsWith("hardlink ")
  );
}

/** Explains `tarball-problem` from the kinds of problems present, not a single canned sentence. */
export function tarballProblemDetail(
  release: Pick<TarballContents, "problems" | "limitReached">,
): string {
  const { problems } = release;
  const explanations: string[] = [];
  if (problems.some(isTarballEscapeProblem)) {
    explanations.push(
      "npm never produces links, absolute paths or traversal; these can escape the install directory when extracted.",
    );
  }
  if (release.limitReached) {
    explanations.push(
      "Reading stopped at a size limit, so the rest of the archive was not examined; an unusually large package, or an archive built to exhaust memory, trips it.",
    );
  }
  const head = problems.join("; ");
  return explanations.length > 0 ? `${head}. ${explanations.join(" ")}` : `${head}.`;
}

/** Findings about the files in the tarball and how they differ from the rebuild. */
export function fileRules(context: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const { release, diff } = context;

  if (release.problems.length > 0) {
    findings.push({
      id: "tarball-problem",
      severity: "critical",
      title: "the release tarball has suspicious entries",
      detail: tarballProblemDetail(release),
      evidence: { problems: release.problems },
    });
  }

  // Paths that should not be in a published package, whether or not the source has them.
  for (const { pattern, why } of UNEXPECTED_PATHS) {
    const matching = [...release.entries.keys()].filter((path) => pattern.test(path)).sort();
    if (matching.length === 0) {
      continue;
    }
    const alsoInSource = context.rebuild
      ? matching.every((path) => context.rebuild?.entries.has(path))
      : undefined;
    findings.push({
      id: "unexpected-path",
      severity: alsoInSource ? "medium" : "high",
      title: `unexpected files in the package: ${matching[0]}${matching.length > 1 ? ` (+${matching.length - 1})` : ""}`,
      detail: `${why}.${alsoInSource ? " The source produces them too, so this is how the package is built." : alsoInSource === false ? " The source does not produce them." : ""}`,
      paths: matching,
    });
  }

  // Native code and binaries present in the release.
  const native = [...release.entries.values()].filter(
    (entry) => entry.kind === "file" && NATIVE_PATTERNS.test(entry.path),
  );
  if (native.length > 0) {
    const notInSource = native.filter((entry) => {
      const expected = context.rebuild?.entries.get(entry.path);
      return !expected || expected.sha256 !== entry.sha256;
    });
    if (context.rebuild && notInSource.length > 0) {
      findings.push({
        id: "native-code-added",
        severity: "critical",
        title: `native code not produced by the source: ${notInSource.map((e) => e.path).join(", ")}`,
        detail:
          "Compiled binaries or native addon definitions that the rebuild did not produce. Their contents cannot be reviewed as source.",
        paths: notInSource.map((entry) => entry.path),
      });
    } else {
      findings.push({
        id: "native-code-present",
        severity: context.rebuild ? "info" : "medium",
        title: `contains native code: ${native.map((e) => e.path).join(", ")}`,
        detail: context.rebuild
          ? "Identical to what the source produces."
          : "Could not be compared with the source.",
        paths: native.map((entry) => entry.path),
      });
    }
  }

  if (!diff) {
    return findings;
  }
  // package.json differences are explained field by field by the manifest rules.
  const changed = diff.changed.filter((change) => change.path !== "package.json");

  if (diff.onlyInRelease.length > 0) {
    findings.push({
      id: "file-added",
      severity: "high",
      title: `${diff.onlyInRelease.length} file${diff.onlyInRelease.length === 1 ? "" : "s"} not produced by the source`,
      detail:
        "These files are in the release but a clean build of the source does not produce them.",
      paths: diff.onlyInRelease.map((entry) => entry.path),
      evidence: Object.fromEntries(
        diff.onlyInRelease.map((entry) => [entry.path, describe(entry)]),
      ),
    });
    const binaries = diff.onlyInRelease.filter(
      (entry) =>
        entry.text === false &&
        !ASSET_EXTENSIONS.has(extension(entry.path)) &&
        !NATIVE_PATTERNS.test(entry.path),
    );
    if (binaries.length > 0) {
      findings.push({
        id: "binary-added",
        severity: "high",
        title: `binary file${binaries.length === 1 ? "" : "s"} not produced by the source`,
        detail: "Binary content that is not an image or font and cannot be reviewed as text.",
        paths: binaries.map((entry) => entry.path),
      });
    }
  }
  if (diff.onlyInRebuild.length > 0) {
    findings.push({
      id: "file-missing",
      severity: "medium",
      title: `${diff.onlyInRebuild.length} file${diff.onlyInRebuild.length === 1 ? "" : "s"} produced by the source are missing from the release`,
      detail: "A clean build produces these files but the release does not contain them.",
      paths: diff.onlyInRebuild.map((entry) => entry.path),
    });
  }

  const typeChanges = changed.filter((change) => change.kind === "type");
  if (typeChanges.length > 0) {
    findings.push({
      id: "file-type-changed",
      severity: "critical",
      title: "file replaced by a different kind of entry",
      detail: typeChanges
        .map((c) => `${c.path}: ${c.release.kind} in the release, ${c.rebuild.kind} in the source`)
        .join("; "),
      paths: typeChanges.map((change) => change.path),
    });
  }
  const contentChanges = changed.filter((change) => change.kind === "content");
  if (contentChanges.length > 0) {
    findings.push({
      id: "file-changed",
      severity: "high",
      title: `${contentChanges.length} file${contentChanges.length === 1 ? "" : "s"} differ from the source`,
      detail: "The content is not what a clean build of the source produces.",
      paths: contentChanges.map((change) => change.path),
      evidence: { patches: patches(contentChanges) },
    });
  }
  const whitespaceChanges = changed.filter((change) => change.kind === "whitespace");
  if (whitespaceChanges.length > 0) {
    findings.push({
      id: "file-changed-whitespace",
      severity: "low",
      title: `${whitespaceChanges.length} file${whitespaceChanges.length === 1 ? "" : "s"} differ only in line endings or trailing whitespace`,
      detail: "Usually a build-environment difference, not an attack; still not byte-identical.",
      paths: whitespaceChanges.map((change) => change.path),
      evidence: { patches: patches(whitespaceChanges) },
    });
  }

  // Obfuscated or minified code that the source does not produce.
  const suspects = [
    ...diff.onlyInRelease.map((entry) => entry.path),
    ...contentChanges.map((change) => change.path),
  ].filter((path) => isCodePath(path));
  const obfuscated: Array<{ path: string; reasons: string[] }> = [];
  const minified: Array<{ path: string; reasons: string[] }> = [];
  for (const path of suspects) {
    const entry = release.entries.get(path);
    if (!entry?.content) {
      continue;
    }
    const signals = analyzeCode(entry.content.toString("utf8"));
    if (signals.obfuscated) {
      obfuscated.push({ path, reasons: signals.reasons });
    } else if (signals.minified) {
      minified.push({ path, reasons: signals.reasons });
    }
  }
  if (obfuscated.length > 0) {
    findings.push({
      id: "obfuscated-code-added",
      severity: "critical",
      title: `obfuscated code not produced by the source: ${obfuscated.map((o) => o.path).join(", ")}`,
      detail: obfuscated.map((o) => `${o.path}: ${o.reasons.join(", ")}`).join("; "),
      paths: obfuscated.map((o) => o.path),
      evidence: Object.fromEntries(obfuscated.map((o) => [o.path, o.reasons])),
    });
  }
  if (minified.length > 0) {
    findings.push({
      id: "minified-code-added",
      severity: "high",
      title: `minified code not produced by the source: ${minified.map((m) => m.path).join(", ")}`,
      detail:
        "Minified files are normal build output, but the rebuild did not produce these bytes, so they cannot be reviewed against the source.",
      paths: minified.map((m) => m.path),
    });
  }
  return findings;
}
