import { ToolError } from "../errors.js";

export interface PackageSpec {
  name: string;
  version: string;
  /** Package URL as used in attestation subjects, e.g. `pkg:npm/%40scope/name@1.2.3`. */
  purl: string;
}

// npm name rules: lowercase, URL-safe, optional @scope/, max 214 chars.
const NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// An exact semver version. Ranges and tags are rejected on purpose: a verdict must be about
// one immutable tarball.
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `<name>@<version>` where the version is exact. */
export function parseSpec(input: string): PackageSpec {
  const at = input.lastIndexOf("@");
  if (at <= 0) {
    if (input.length <= 214 && NAME_RE.test(input)) {
      throw new ToolError(
        `Give an exact version: ${input}@<version>, for example ${input}@1.2.3 (npm view ${input} version prints the latest)`,
      );
    }
    throw new ToolError(`Expected <name>@<version>, got "${input}"`);
  }
  const name = input.slice(0, at);
  const version = input.slice(at + 1);
  if (name.length > 214 || !NAME_RE.test(name)) {
    throw new ToolError(`Invalid package name "${name}"`);
  }
  if (!VERSION_RE.test(version)) {
    throw new ToolError(`Expected an exact version such as 1.2.3, got "${version}"`);
  }
  return { name, version, purl: toPurl(name, version) };
}

/** Same encoding as npm-package-arg's toPurl: only the leading `@` of a scope is escaped. */
export function toPurl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}
