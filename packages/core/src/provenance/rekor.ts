import { createHash } from "node:crypto";
import { errorMessage, ToolError } from "../errors.js";
import type { AttestationEntry } from "../fetch/types.js";
import { normalizeGithubRepository } from "../rules/repository.js";
import {
  extractCertificateIdentity,
  GITHUB_ACTIONS_ISSUER,
  splitWorkflowUri,
} from "./certificate.js";
import { readCertificateExtensions } from "./der.js";
import {
  GITHUB_BUILDER_ID_PREFIX,
  GITHUB_WORKFLOW_BUILD_TYPE,
  INTOTO_PAYLOAD_TYPE,
  INTOTO_STATEMENT_V1,
  SLSA_PROVENANCE_V1,
} from "./predicate.js";
import type { ProvenanceResult } from "./types.js";
import { type VerifyProvenanceOptions, verifyProvenance } from "./verify.js";

export const DEFAULT_REKOR_URL = "https://rekor.sigstore.dev/";

/** More entries than this for one tarball is not an honest release; we do not try them all. */
export const MAX_REKOR_ENTRIES = 10;

const BUNDLE_V03 = "application/vnd.dev.sigstore.bundle.v0.3+json";
const ENTRY_UUID_RE = /^(?:[0-9a-f]{16})?[0-9a-f]{64}$/;
const HEX_RE = /^(?:[0-9a-f]{2})+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface RekorOptions {
  /** Rekor base URL. Defaults to the public Sigstore instance npm writes to. */
  rekorUrl?: string | undefined;
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface RekorSubject {
  purl: string;
  /** Hex SHA-512 of the tarball we actually downloaded. */
  sha512Hex: string;
}

export interface RekorCandidates {
  /** Each DSSE entry found for the digest, as a Sigstore bundle that is not verified yet. */
  attestations: Array<AttestationEntry & { logIndex: number }>;
  /** Entries that could not be turned into a bundle, and why. */
  skipped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && value.length % 4 === 0 && BASE64_RE.test(value);
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

async function rekorRequest(path: string, options: RekorOptions, body?: unknown): Promise<unknown> {
  const url = new URL(path, options.rekorUrl ?? DEFAULT_REKOR_URL).href;
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    const init: RequestInit = {
      headers: { accept: "application/json", "user-agent": "releaseproof" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    };
    if (body !== undefined) {
      init.method = "POST";
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    response = await doFetch(url, init);
  } catch (error) {
    throw new ToolError(`Request to ${url} failed: ${errorMessage(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new ToolError(`Rekor returned HTTP ${response.status} for ${path}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ToolError(`Rekor returned invalid JSON for ${path}`, { cause: error });
  }
}

/** `-----BEGIN CERTIFICATE-----` PEM to DER, or undefined for anything else (a bare public key). */
function certificateDer(pem: string): Buffer | undefined {
  const match =
    /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/.exec(
      pem,
    );
  return match?.[1] ? Buffer.from(match[1].replace(/\s+/g, ""), "base64") : undefined;
}

/**
 * The in-toto statement npm writes for a publish from GitHub Actions, rebuilt from the
 * certificate (libnpmpublish `provenance.js`; every value there comes from a GITHUB_* variable
 * that Fulcio also puts into the certificate). Rekor's `dsse` entries store only the hash of
 * the statement, not the statement. A rebuilt statement is only ever used when its SHA-256
 * equals that signed hash, so a guess that is wrong in any byte is rejected, never trusted.
 */
export function npmGithubStatement(der: Uint8Array, subject: RekorSubject): Buffer | undefined {
  const oids = readCertificateExtensions(der);
  if (!oids) {
    return undefined;
  }
  const certificate = extractCertificateIdentity({ oids });
  const {
    issuer,
    sourceRepositoryUri: repository,
    sourceRepositoryDigest: commit,
    sourceRepositoryRef: ref,
    buildConfigUri,
    buildTrigger,
    sourceRepositoryId,
    sourceRepositoryOwnerId,
    runnerEnvironment,
    runInvocationUri,
  } = certificate;
  if (
    issuer !== GITHUB_ACTIONS_ISSUER ||
    !repository ||
    !commit ||
    !ref ||
    !buildConfigUri ||
    !runnerEnvironment ||
    !runInvocationUri
  ) {
    return undefined;
  }
  const workflow = splitWorkflowUri(buildConfigUri, repository);
  if (!workflow) {
    return undefined;
  }
  const statement = {
    _type: INTOTO_STATEMENT_V1,
    subject: [{ name: subject.purl, digest: { sha512: subject.sha512Hex.toLowerCase() } }],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: GITHUB_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: { ref: workflow.ref, repository, path: workflow.path },
        },
        internalParameters: {
          github: {
            event_name: buildTrigger,
            repository_id: sourceRepositoryId,
            repository_owner_id: sourceRepositoryOwnerId,
          },
        },
        resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: commit } }],
      },
      runDetails: {
        builder: { id: `${GITHUB_BUILDER_ID_PREFIX}${runnerEnvironment}` },
        metadata: { invocationId: runInvocationUri },
      },
    },
  };
  return Buffer.from(JSON.stringify(statement), "utf8");
}

/**
 * Turns one Rekor log entry (the value of `GET /api/v1/log/entries/{uuid}`) into the Sigstore
 * bundle npm would have served, the same conversion sigstore-js does when it signs. Returns
 * a reason instead when the entry is not a DSSE provenance about this tarball.
 */
export function bundleFromRekorEntry(
  entry: unknown,
  subject: RekorSubject,
): { bundle: Record<string, unknown>; logIndex: number } | { skipped: string } {
  if (!isRecord(entry) || !isBase64(entry.body)) {
    return { skipped: "malformed log entry" };
  }
  const { logIndex, integratedTime, logID, verification } = entry;
  if (!isIndex(logIndex) || !isIndex(integratedTime) || !isHex(logID) || !isRecord(verification)) {
    return { skipped: "malformed log entry" };
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(entry.body, "base64").toString("utf8"));
  } catch {
    return { skipped: `entry ${logIndex} has a malformed body` };
  }
  if (!isRecord(body) || body.kind !== "dsse" || body.apiVersion !== "0.0.1") {
    const kind = isRecord(body) ? `${String(body.kind)} ${String(body.apiVersion)}` : "unknown";
    return { skipped: `entry ${logIndex} is a ${kind} entry, not a DSSE attestation` };
  }
  const spec = isRecord(body.spec) ? body.spec : {};
  const signatures = Array.isArray(spec.signatures) ? spec.signatures : [];
  const [signature] = signatures;
  const payloadHash = isRecord(spec.payloadHash) ? spec.payloadHash : {};
  if (
    signatures.length !== 1 ||
    !isRecord(signature) ||
    !isBase64(signature.signature) ||
    !isBase64(signature.verifier) ||
    payloadHash.algorithm !== "sha256" ||
    !isHex(payloadHash.value)
  ) {
    return { skipped: `entry ${logIndex} is not a single-signature DSSE entry` };
  }
  const der = certificateDer(Buffer.from(signature.verifier, "base64").toString("utf8"));
  if (!der) {
    return { skipped: `entry ${logIndex} is not signed with a certificate` };
  }

  // Rekor keeps the statement itself only when attestation storage holds it; otherwise
  // rebuild it. Either way the signed payload hash decides, and sigstore checks it again.
  const candidates: Buffer[] = [];
  const stored = isRecord(entry.attestation) ? entry.attestation.data : undefined;
  if (isBase64(stored)) {
    candidates.push(Buffer.from(stored, "base64"));
  }
  const rebuilt = npmGithubStatement(der, subject);
  if (rebuilt) {
    candidates.push(rebuilt);
  }
  const payload = candidates.find(
    (candidate) => createHash("sha256").update(candidate).digest("hex") === payloadHash.value,
  );
  if (!payload) {
    return {
      skipped: `entry ${logIndex} signs a statement that is not npm's provenance for ${subject.purl}`,
    };
  }

  const tlogEntry: Record<string, unknown> = {
    logIndex: String(logIndex),
    logId: { keyId: hexToBase64(logID) },
    kindVersion: { kind: body.kind, version: body.apiVersion },
    integratedTime: String(integratedTime),
    canonicalizedBody: entry.body,
  };
  if (isBase64(verification.signedEntryTimestamp)) {
    tlogEntry.inclusionPromise = { signedEntryTimestamp: verification.signedEntryTimestamp };
  }
  const proof = verification.inclusionProof;
  if (isRecord(proof)) {
    const hashes = Array.isArray(proof.hashes) ? proof.hashes : [];
    if (
      !isIndex(proof.logIndex) ||
      !isIndex(proof.treeSize) ||
      !isHex(proof.rootHash) ||
      typeof proof.checkpoint !== "string" ||
      !hashes.every(isHex)
    ) {
      return { skipped: `entry ${logIndex} has a malformed inclusion proof` };
    }
    tlogEntry.inclusionProof = {
      logIndex: String(proof.logIndex),
      rootHash: hexToBase64(proof.rootHash),
      treeSize: String(proof.treeSize),
      hashes: hashes.map(hexToBase64),
      checkpoint: { envelope: proof.checkpoint },
    };
  }
  return {
    logIndex,
    bundle: {
      mediaType: BUNDLE_V03,
      verificationMaterial: {
        certificate: { rawBytes: der.toString("base64") },
        tlogEntries: [tlogEntry],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: payload.toString("base64"),
        payloadType: INTOTO_PAYLOAD_TYPE,
        signatures: [{ sig: signature.signature, keyid: "" }],
      },
    },
  };
}

/**
 * Looks the tarball up in Rekor by its SHA-512 (the search index holds the subject digests
 * of in-toto statements) and returns every DSSE entry as an unverified bundle. Nothing here
 * is trusted: the index is not part of the log, and anyone can write entries to it.
 * Throws ToolError when Rekor cannot be reached.
 */
export async function findRekorAttestations(
  subject: RekorSubject,
  options: RekorOptions = {},
): Promise<RekorCandidates> {
  const sha512 = subject.sha512Hex.toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sha512)) {
    throw new ToolError(`Not a SHA-512 digest: "${subject.sha512Hex}"`);
  }
  const found = await rekorRequest("api/v1/index/retrieve", options, { hash: `sha512:${sha512}` });
  if (!Array.isArray(found) || !found.every((uuid) => typeof uuid === "string")) {
    throw new ToolError("Rekor returned an unexpected search result");
  }
  const uuids = [...new Set(found.map((uuid) => uuid.toLowerCase()))];
  const result: RekorCandidates = { attestations: [], skipped: [] };
  if (uuids.length > MAX_REKOR_ENTRIES) {
    result.skipped.push(
      `Rekor lists ${uuids.length} entries for this tarball, more than the ${MAX_REKOR_ENTRIES} releaseproof checks`,
    );
    return result;
  }
  for (const uuid of uuids) {
    if (!ENTRY_UUID_RE.test(uuid)) {
      result.skipped.push(`Rekor returned a malformed entry id "${uuid.slice(0, 80)}"`);
      continue;
    }
    const response = await rekorRequest(`api/v1/log/entries/${uuid}`, options);
    const entry = isRecord(response) ? response[uuid] : undefined;
    const converted = bundleFromRekorEntry(entry, { purl: subject.purl, sha512Hex: sha512 });
    if ("skipped" in converted) {
      result.skipped.push(`Rekor ${converted.skipped}`);
      continue;
    }
    result.attestations.push({
      predicateType: SLSA_PROVENANCE_V1,
      bundle: converted.bundle,
      logIndex: converted.logIndex,
    });
  }
  result.attestations.sort((a, b) => a.logIndex - b.logIndex);
  return result;
}

export interface RekorProvenanceOptions extends VerifyProvenanceOptions, RekorOptions {
  /**
   * The repository the release must come from. Required: anyone can sign a statement about
   * any digest and write it to Rekor, so only an entry from this repository can count.
   */
  expectedRepository: string;
  /** Injectable lookup, for tests. */
  find?: typeof findRekorAttestations | undefined;
}

export interface RekorProvenance {
  /** Verified provenance from Rekor, or undefined when no entry may upgrade the source. */
  provenance: ProvenanceResult | undefined;
  /** What was found and why it did not count. Shown as notes; never a verdict on its own. */
  notes: string[];
}

/**
 * Provenance for a tarball whose registry attestations are hidden (a staged version): every
 * Rekor entry for its digest is verified exactly like a registry attestation, and the one
 * built from the expected repository is used. Entries that fail, or name another repository,
 * are only notes: they cost an attacker nothing to write. Several verified entries that
 * disagree on the commit upgrade nothing.
 */
export async function findRekorProvenance(
  subject: RekorSubject,
  options: RekorProvenanceOptions,
): Promise<RekorProvenance> {
  const find = options.find ?? findRekorAttestations;
  const { attestations, skipped } = await find(subject, options);
  const notes = [...skipped];
  const expected = normalizeGithubRepository(options.expectedRepository);
  if (attestations.length === 0) {
    if (notes.length === 0) {
      notes.push("the Rekor transparency log has no provenance for this tarball");
    }
    return { provenance: undefined, notes };
  }

  const accepted: ProvenanceResult[] = [];
  for (const { logIndex, ...attestation } of attestations) {
    const result = await verifyProvenance(
      { ...subject, attestations: { attestations: [attestation] } },
      options,
    );
    const repository = result.source?.repository;
    if (result.status !== "verified" || !repository) {
      notes.push(
        `Rekor entry ${logIndex} is ${result.status}: ${result.problems.join("; ") || "no source"}`,
      );
    } else if (!expected || normalizeGithubRepository(repository) !== expected) {
      notes.push(
        `Rekor entry ${logIndex} was built from ${repository}, not ${options.expectedRepository}; ignored`,
      );
    } else {
      accepted.push(result);
    }
  }
  const [first] = accepted;
  if (!first?.source) {
    return { provenance: undefined, notes };
  }
  const commits = new Set(accepted.map((result) => result.source?.commit));
  if (commits.size > 1) {
    notes.push(
      `Rekor has provenance for this tarball from ${commits.size} different commits of ${first.source.repository}; none is used`,
    );
    return { provenance: undefined, notes };
  }
  first.attestationSource = "rekor";
  first.warnings.push(...notes);
  return { provenance: first, notes: [] };
}
