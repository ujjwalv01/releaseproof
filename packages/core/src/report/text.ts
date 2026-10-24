import type { CheckReport } from "../check/run.js";
import type { Finding } from "../rules/types.js";

export interface FormatOptions {
  /** Lines of each patch to show before truncating. */
  maxPatchLines?: number | undefined;
  maxPaths?: number | undefined;
}

const LABEL = 13;

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL)}${value}\n`;
}

function cont(value: string): string {
  return `${" ".repeat(LABEL)}${value}\n`;
}

function duration(ms: number | undefined): string {
  if (ms === undefined) {
    return "";
  }
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? ` (${Math.floor(seconds / 60)}m ${seconds % 60}s)` : ` (${seconds}s)`;
}

function shortRepo(repository: string): string {
  return repository.replace(/^https:\/\/github\.com\//, "");
}

/**
 * One line pointing at the Rekor entry of a verified bundle. The values were checked by
 * sigstore, but they still end up in a URL, so only an all-digit log index is printed and
 * the integration time (seconds since the epoch) is shown as a date only when it parses.
 */
function transparencyLogLine(
  log: CheckReport["provenance"]["transparencyLog"],
): string | undefined {
  if (!log || !/^\d+$/.test(log.logIndex)) {
    return undefined;
  }
  const seconds = /^\d+$/.test(log.integratedTime) ? Number(log.integratedTime) : Number.NaN;
  const date = new Date(seconds * 1000);
  const when = Number.isNaN(date.getTime()) ? "" : `, integrated ${date.toISOString()}`;
  return `log https://search.sigstore.dev/?logIndex=${log.logIndex}${when}`;
}

function provenanceLines(report: CheckReport): string {
  const { provenance } = report;
  const status = provenance.status.toUpperCase();
  if (provenance.status === "verified" && provenance.source) {
    const s = provenance.source;
    let out = row(
      "Provenance",
      `${status}  ${shortRepo(s.repository)}@${s.commit.slice(0, 7)} on ${s.ref}`,
    );
    const details = [
      s.workflowPath ? `workflow ${s.workflowPath}` : "",
      s.trigger ? `trigger ${s.trigger}` : "",
      s.runnerEnvironment ? `${s.runnerEnvironment} runner` : "",
    ].filter((part) => part !== "");
    if (details.length > 0) {
      out += cont(details.join(", "));
    }
    const log = transparencyLogLine(provenance.transparencyLog);
    if (log) {
      out += cont(log);
    }
    return out;
  }
  const why = provenance.problems.length > 0 ? `  ${provenance.problems.join("; ")}` : "";
  return row("Provenance", `${status}${why}`);
}

function rebuildLines(report: CheckReport): string {
  const { rebuild, source } = report;
  if (!rebuild) {
    return row("Rebuild", source ? "not run" : "not run (no source)");
  }
  const digestLine = rebuild.imageDigest
    ? cont(
        `image digest ${rebuild.imageDigest.replace(/(sha256:[a-f0-9]{16})[a-f0-9]{48}$/i, "$1…")}`,
      )
    : "";
  if (rebuild.status !== "ok") {
    let out = row("Rebuild", `FAILED${duration(rebuild.durationMs)}  ${rebuild.failure ?? ""}`);
    out += digestLine;
    const failed = [...rebuild.stages]
      .reverse()
      .find((stage) => stage.exitCode !== 0 || stage.timedOut);
    if (failed?.output) {
      const lines = failed.output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-20);
      out += cont(`last output of the ${failed.stage} stage:`);
      for (const line of lines) {
        out += cont(`  ${line}`);
      }
    }
    return out;
  }
  const parts = [
    rebuild.image ?? "",
    rebuild.toolVersion ?? "",
    rebuild.plan ? `build: ${rebuild.plan.buildSource}` : "",
  ].filter((part) => part !== "");
  let out = row("Rebuild", `OK${duration(rebuild.durationMs)}  ${parts.join(", ")}`);
  out += digestLine;
  if (source && !source.verified) {
    out += cont(
      `from ${shortRepo(source.repository)}@${source.commit.slice(0, 7)} as given by --repo/--commit`,
    );
  }
  return out;
}

function filesLine(report: CheckReport): string {
  const { diff } = report;
  if (!diff) {
    return row("Files", `${report.package.files} in the release; nothing to compare with`);
  }
  const parts = [
    `${diff.identical} identical`,
    `${diff.changed.length} changed`,
    `${diff.onlyInRelease.length} only in release`,
    `${diff.onlyInRebuild.length} only in rebuild`,
  ];
  if (diff.permissionDifferences > 0) {
    parts.push(`${diff.permissionDifferences} with different permissions (ignored)`);
  }
  return row("Files", parts.join(", "));
}

function patchesOf(finding: Finding): Record<string, string> {
  const patches = finding.evidence?.patches;
  if (typeof patches !== "object" || patches === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [path, patch] of Object.entries(patches)) {
    if (typeof patch === "string") {
      out[path] = patch;
    }
  }
  return out;
}

function findingLines(finding: Finding, options: FormatOptions): string {
  const maxPaths = options.maxPaths ?? 10;
  const maxPatchLines = options.maxPatchLines ?? 40;
  let out = `  ${finding.severity.toUpperCase().padEnd(9)} ${finding.id}\n`;
  out += `            ${finding.title}\n`;
  if (finding.detail !== finding.title) {
    out += `            ${finding.detail}\n`;
  }
  const paths = finding.paths ?? [];
  if (paths.length > 1 || (paths.length === 1 && !finding.title.includes(paths[0] ?? ""))) {
    for (const path of paths.slice(0, maxPaths)) {
      out += `              ${path}\n`;
    }
    if (paths.length > maxPaths) {
      out += `              … ${paths.length - maxPaths} more\n`;
    }
  }
  for (const [path, patch] of Object.entries(patchesOf(finding))) {
    const lines = patch.split("\n").filter((line) => line !== "");
    out += `            --- ${path}\n`;
    for (const line of lines.slice(2, 2 + maxPatchLines)) {
      out += `            ${line}\n`;
    }
    if (lines.length - 2 > maxPatchLines) {
      out += `            … ${lines.length - 2 - maxPatchLines} more lines (see --json)\n`;
    }
  }
  return out;
}

/** The human-readable report. Plain text, no colour, stable layout. */
export function formatReport(report: CheckReport, options: FormatOptions = {}): string {
  const { package: pkg, verdict } = report;
  let out = `releaseproof check ${pkg.name}@${pkg.version}\n\n`;
  out += row(
    "Package",
    `${pkg.name}@${pkg.version} (${new URL(pkg.registry).host}${pkg.origin === "staged" ? ", staged" : ""}), ${pkg.files} files, sha512 ${pkg.sha512.slice(0, 12)}…`,
  );
  out += provenanceLines(report);
  out += rebuildLines(report);
  out += filesLine(report);
  out += "\n";
  if (verdict.findings.length === 0) {
    out += "Findings     none\n";
  } else {
    const { counts } = verdict;
    const summary = (["critical", "high", "medium", "low", "info"] as const)
      .filter((severity) => counts[severity] > 0)
      .map((severity) => `${counts[severity]} ${severity}`)
      .join(", ");
    out += `Findings     ${verdict.findings.length} (${summary})\n`;
    for (const finding of verdict.findings) {
      out += findingLines(finding, options);
    }
  }
  out += `\nVerdict: ${verdict.summary}\n`;
  for (const reason of verdict.reasons.slice(1)) {
    out += `         ${reason}\n`;
  }
  return out;
}
