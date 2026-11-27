import { ToolError } from "../errors.js";
import { resolveToken } from "../registry/auth.js";
import {
  normalizeRegistry,
  type RegistryOptions,
  registryBytes,
  registryJson,
} from "../registry/client.js";
import { type PackageSpec, parseSpec } from "../registry/spec.js";
import { base64ToHex, computeDigests, sha512FromIntegrity } from "./digests.js";
import type {
  AttestationsResponse,
  DistInfo,
  RegistrySignature,
  ReleaseArtifact,
} from "./types.js";

export type FetchPublishedOptions = RegistryOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Keeps only the `dist` fields we understand, with their types checked. */
export function readDist(dist: unknown): DistInfo {
  if (!isRecord(dist)) {
    return {};
  }
  const out: DistInfo = {
    integrity: optionalString(dist.integrity),
    shasum: optionalString(dist.shasum),
    tarball: optionalString(dist.tarball),
  };
  if (Array.isArray(dist.signatures)) {
    const signatures: RegistrySignature[] = [];
    for (const entry of dist.signatures) {
      if (isRecord(entry) && typeof entry.keyid === "string" && typeof entry.sig === "string") {
        signatures.push({ keyid: entry.keyid, sig: entry.sig });
      }
    }
    out.signatures = signatures;
  }
  if (isRecord(dist.attestations) && typeof dist.attestations.url === "string") {
    const provenance = dist.attestations.provenance;
    out.attestations = {
      url: dist.attestations.url,
      provenance:
        isRecord(provenance) && typeof provenance.predicateType === "string"
          ? { predicateType: provenance.predicateType }
          : undefined,
    };
  }
  return out;
}

/** Validates the shape of an attestations response. Anything else is treated as absent. */
export function readAttestations(body: unknown): AttestationsResponse | null {
  if (!isRecord(body) || !Array.isArray(body.attestations)) {
    return null;
  }
  const attestations: AttestationsResponse["attestations"] = [];
  for (const entry of body.attestations) {
    if (isRecord(entry) && typeof entry.predicateType === "string" && isRecord(entry.bundle)) {
      attestations.push({ predicateType: entry.predicateType, bundle: entry.bundle });
    } else {
      // One malformed entry makes the whole response untrustworthy.
      return null;
    }
  }
  return { attestations };
}

function repositoryHint(repository: unknown): string | undefined {
  if (typeof repository === "string") {
    return repository;
  }
  return isRecord(repository) ? optionalString(repository.url) : undefined;
}

/** Registry path of a version document. Scoped names encode the slash, as npm does. */
export function versionPath(spec: PackageSpec): string {
  return `/${spec.name.replace("/", "%2f")}/${spec.version}`;
}

/**
 * The registry-relative path of an absolute URL the registry handed us, so the request goes
 * to our configured registry whatever host the URL names. A registry base path such as
 * `/npm/` is stripped when the URL shares it.
 */
export function registryRelativePath(registry: string, url: string, what: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw new ToolError(`Registry gave an invalid ${what} URL: ${url}`);
  }
  const base = new URL(normalizeRegistry(registry)).pathname;
  return base !== "/" && pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname;
}

/**
 * Fetches a published version: version document, integrity-checked tarball and its
 * attestations. Everything is fetched by path against our configured registry; the absolute
 * URLs in the version document are untrusted data and only lend their paths.
 */
export async function fetchPublished(
  input: string | PackageSpec,
  options: FetchPublishedOptions = {},
): Promise<ReleaseArtifact> {
  const spec = typeof input === "string" ? parseSpec(input) : input;
  const registry = normalizeRegistry(options.registry);
  const token = resolveToken(registry, {
    explicit: options.token,
    env: options.env,
    npmrcPaths: options.npmrcPaths,
  });
  const requestOptions: RegistryOptions = { ...options, registry, token };
  const specString = `${spec.name}@${spec.version}`;

  const manifest = await registryJson<unknown>(versionPath(spec), requestOptions);
  if (manifest === null) {
    throw new ToolError(
      `${specString} was not found on ${registry}. If it was just published, retry in a minute or run the check after the publish job (needs: publish). A staged version that is not approved yet is checked with --stage <id>.`,
    );
  }
  if (!isRecord(manifest) || manifest.name !== spec.name || manifest.version !== spec.version) {
    const got = isRecord(manifest)
      ? `${String(manifest.name)}@${String(manifest.version)}`
      : "an unexpected document";
    throw new ToolError(`Registry returned ${got} when asked for ${specString}`);
  }

  const dist = readDist(manifest.dist);
  const integrity = dist.integrity;
  const expectedSha512 = integrity ? sha512FromIntegrity(integrity) : undefined;
  if (!integrity || !expectedSha512) {
    throw new ToolError(`Registry did not provide a sha512 integrity for ${specString}`);
  }
  if (!dist.tarball) {
    throw new ToolError(`Registry did not provide a tarball URL for ${specString}`);
  }

  const tarball = await registryBytes(
    registryRelativePath(registry, dist.tarball, "tarball"),
    requestOptions,
  );
  const digests = computeDigests(tarball);
  if (digests.sha512Base64 !== expectedSha512) {
    throw new ToolError(
      `Tarball for ${specString} does not match its integrity (expected sha512 ${base64ToHex(
        expectedSha512,
      )}, got ${digests.sha512Hex})`,
    );
  }

  let attestations: AttestationsResponse | null = null;
  if (dist.attestations) {
    const body = await registryJson<unknown>(
      registryRelativePath(registry, dist.attestations.url, "attestations"),
      requestOptions,
    );
    attestations = readAttestations(body);
  }

  return {
    origin: { kind: "published", registry },
    name: spec.name,
    version: spec.version,
    purl: spec.purl,
    tarball,
    digests,
    dist,
    hints: {
      gitHead: optionalString(manifest.gitHead),
      repository: repositoryHint(manifest.repository),
    },
    attestations,
  };
}
