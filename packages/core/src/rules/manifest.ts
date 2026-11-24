import type { TarballContents } from "../diff/tarball.js";
import type { Finding, RuleContext } from "./types.js";

/** Scripts npm runs when the package is installed as a dependency. */
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;
/** Scripts that run in other flows (git installs, publishing) and can still execute code. */
export const OTHER_LIFECYCLE_SCRIPTS = [
  "prepare",
  "prepublish",
  "preprepare",
  "postprepare",
  "prepublishOnly",
  "prepack",
  "postpack",
] as const;
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;
export const ENTRY_POINT_FIELDS = [
  "main",
  "module",
  "browser",
  "exports",
  "bin",
  "types",
  "typings",
  "imports",
] as const;

type Manifest = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ManifestRead = { ok: true; manifest: Manifest } | { ok: false; problem: string };

/** Parses `package.json` from a tarball without trusting it. */
export function readManifest(tarball: TarballContents): ManifestRead {
  const entry = tarball.entries.get("package.json");
  if (entry?.kind !== "file") {
    return { ok: false, problem: "package.json is missing" };
  }
  if (!entry.content) {
    return { ok: false, problem: "package.json is too large to read" };
  }
  try {
    const parsed: unknown = JSON.parse(entry.content.toString("utf8"));
    return isRecord(parsed)
      ? { ok: true, manifest: parsed }
      : { ok: false, problem: "package.json is not an object" };
  } catch {
    return { ok: false, problem: "package.json is not valid JSON" };
  }
}

export function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        out[key] = entry;
      }
    }
  } else if (Array.isArray(value)) {
    // bundleDependencies may be a list of names.
    for (const entry of value) {
      if (typeof entry === "string") {
        out[entry] = "*";
      }
    }
  }
  return out;
}

/** JSON with object keys sorted, so key order never counts as a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function describeDependency(field: string, name: string): string {
  return field === "dependencies" ? name : `${name} (${field})`;
}

/** Findings about the release's package.json, compared with the rebuilt one when available. */
export function manifestRules(context: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const release = readManifest(context.release);
  if (!release.ok) {
    findings.push({
      id: "manifest-unreadable",
      severity: "critical",
      title: "package.json cannot be read",
      detail: `${release.problem}. A package that npm cannot read is not a normal release.`,
      paths: ["package.json"],
    });
    return findings;
  }
  const rebuild = context.rebuild ? readManifest(context.rebuild) : undefined;
  if (rebuild && !rebuild.ok) {
    findings.push({
      id: "rebuild-manifest-unreadable",
      severity: "high",
      title: "the rebuilt package.json cannot be read",
      detail: `${rebuild.problem} in the rebuild, so package.json could not be compared.`,
      paths: ["package.json"],
    });
  }
  const expected = rebuild?.ok ? rebuild.manifest : undefined;
  if (expected && same(release.manifest, expected)) {
    const releaseBytes = context.release.entries.get("package.json")?.sha256;
    const rebuildBytes = context.rebuild?.entries.get("package.json")?.sha256;
    if (releaseBytes !== rebuildBytes) {
      findings.push({
        id: "manifest-formatting-changed",
        severity: "low",
        title: "package.json differs only in formatting",
        detail:
          "Same fields and values, different bytes (indentation, key order or line endings). Package managers rewrite package.json when they pack, so this is common.",
        paths: ["package.json"],
      });
    }
  }

  const releaseScripts = stringMap(release.manifest.scripts);
  const expectedScripts = expected ? stringMap(expected.scripts) : undefined;
  for (const name of INSTALL_SCRIPTS) {
    const command = releaseScripts[name];
    if (command === undefined) {
      continue;
    }
    if (!expectedScripts) {
      findings.push({
        id: "install-script-present",
        severity: "medium",
        title: `runs code on install: "${name}"`,
        detail: `package.json has "${name}": "${command}". It could not be compared with the source, so make sure it is yours.`,
        paths: ["package.json"],
        evidence: { script: name, command },
      });
    } else if (!(name in expectedScripts)) {
      findings.push({
        id: "install-script-added",
        severity: "critical",
        title: `install script added: "${name}"`,
        detail: `The release runs "${command}" on install; the source at this commit has no "${name}" script. This is how malicious releases execute code on every install.`,
        paths: ["package.json"],
        evidence: { script: name, command },
      });
    } else if (expectedScripts[name] !== command) {
      findings.push({
        id: "install-script-changed",
        severity: "critical",
        title: `install script changed: "${name}"`,
        detail: `The release runs "${command}" on install; the source runs "${expectedScripts[name]}".`,
        paths: ["package.json"],
        evidence: { script: name, release: command, rebuild: expectedScripts[name] },
      });
    } else {
      findings.push({
        id: "install-script-present",
        severity: "info",
        title: `runs code on install: "${name}" (same as source)`,
        detail: `package.json has "${name}": "${command}", identical to the source.`,
        paths: ["package.json"],
        evidence: { script: name, command },
      });
    }
  }
  if (expectedScripts) {
    for (const name of OTHER_LIFECYCLE_SCRIPTS) {
      const command = releaseScripts[name];
      if (command === undefined) {
        continue;
      }
      if (!(name in expectedScripts)) {
        findings.push({
          id: "lifecycle-script-added",
          severity: "high",
          title: `lifecycle script added: "${name}"`,
          detail: `The release has "${name}": "${command}", which the source does not. It runs in some install and publish flows.`,
          paths: ["package.json"],
          evidence: { script: name, command },
        });
      } else if (expectedScripts[name] !== command) {
        findings.push({
          id: "lifecycle-script-changed",
          severity: "high",
          title: `lifecycle script changed: "${name}"`,
          detail: `"${name}" is "${command}" in the release and "${expectedScripts[name]}" in the source.`,
          paths: ["package.json"],
          evidence: { script: name, release: command, rebuild: expectedScripts[name] },
        });
      }
    }
  }

  if (expected) {
    for (const field of DEPENDENCY_FIELDS) {
      const releaseDeps = stringMap(release.manifest[field]);
      const expectedDeps = stringMap(expected[field]);
      for (const [name, range] of Object.entries(releaseDeps)) {
        if (!(name in expectedDeps)) {
          findings.push({
            id: "dependency-added",
            severity: "high",
            title: `dependency added: ${describeDependency(field, name)}`,
            detail: `The release depends on ${name}@${range}; the source does not. New dependencies are a common way to pull in malicious code.`,
            paths: ["package.json"],
            evidence: { field, name, range },
          });
        } else if (expectedDeps[name] !== range) {
          const expectedRange = expectedDeps[name] ?? "";
          const repointed = isNonRegistrySpec(range) && !isNonRegistrySpec(expectedRange);
          findings.push({
            id: "dependency-changed",
            severity:
              isNonRegistrySpec(range) && !isNonRegistrySpec(expectedRange) ? "high" : "medium",
            title: `dependency range changed: ${describeDependency(field, name)}`,
            detail: repointed
              ? `${name} is "${range}" in the release and "${expectedRange}" in the source, repointing the dependency away from the registry.`
              : `${name} is "${range}" in the release and "${expectedRange}" in the source.`,
            paths: ["package.json"],
            evidence: { field, name, release: range, rebuild: expectedRange },
          });
        }
      }
      for (const name of Object.keys(expectedDeps)) {
        if (!(name in releaseDeps)) {
          findings.push({
            id: "dependency-removed",
            severity: "low",
            title: `dependency removed: ${describeDependency(field, name)}`,
            detail: `The source depends on ${name}; the release does not.`,
            paths: ["package.json"],
            evidence: { field, name },
          });
        }
      }
    }

    for (const field of ENTRY_POINT_FIELDS) {
      if (!same(release.manifest[field], expected[field])) {
        findings.push({
          id: "entry-point-changed",
          severity: "high",
          title: `entry point changed: "${field}"`,
          detail: `"${field}" differs between the release and the source, so a different file would run when the package is imported or executed.`,
          paths: ["package.json"],
          evidence: { field, release: release.manifest[field], rebuild: expected[field] },
        });
      }
    }

    const covered = new Set<string>([...DEPENDENCY_FIELDS, ...ENTRY_POINT_FIELDS, "scripts"]);
    const otherFields = [...new Set([...Object.keys(release.manifest), ...Object.keys(expected)])]
      .filter((field) => !covered.has(field) && !same(release.manifest[field], expected[field]))
      .sort();
    if (otherFields.length > 0) {
      findings.push({
        id: "manifest-field-changed",
        severity: "medium",
        title: `package.json fields differ: ${otherFields.join(", ")}`,
        detail:
          "These fields are not the same in the release and the rebuild. Version bumps made by release tooling after the commit show up here; so does anything an attacker edited.",
        paths: ["package.json"],
        evidence: Object.fromEntries(
          otherFields.map((field) => [
            field,
            { release: release.manifest[field], rebuild: expected[field] },
          ]),
        ),
      });
    }
    const otherScripts = [
      ...new Set([
        ...Object.keys(releaseScripts),
        ...(expectedScripts ? Object.keys(expectedScripts) : []),
      ]),
    ]
      .filter(
        (name) =>
          !(INSTALL_SCRIPTS as readonly string[]).includes(name) &&
          !(OTHER_LIFECYCLE_SCRIPTS as readonly string[]).includes(name) &&
          releaseScripts[name] !== expectedScripts?.[name],
      )
      .sort();
    if (otherScripts.length > 0) {
      findings.push({
        id: "script-changed",
        severity: "low",
        title: `other scripts differ: ${otherScripts.join(", ")}`,
        detail: "These scripts do not run on install, but they differ from the source.",
        paths: ["package.json"],
        evidence: Object.fromEntries(
          otherScripts.map((name) => [
            name,
            { release: releaseScripts[name], rebuild: expectedScripts?.[name] },
          ]),
        ),
      });
    }
  }
  return findings;
}

const NON_REGISTRY_PREFIXES = [
  "git+",
  "git:",
  "git@",
  "github:",
  "gitlab:",
  "bitbucket:",
  "gist:",
  "http:",
  "https:",
  "file:",
  "link:",
  "npm:",
];

function isNonRegistrySpec(range: string): boolean {
  const trimmed = range.trim().toLowerCase();
  if (NON_REGISTRY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+/i.test(trimmed);
}
