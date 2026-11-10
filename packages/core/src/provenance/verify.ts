import { verify } from "sigstore";
import { errorMessage } from "../errors.js";
import type { AttestationEntry, AttestationsResponse } from "../fetch/types.js";
import {
  extractCertificateIdentity,
  GITHUB_ACTIONS_ISSUER,
  type SignerIdentityLike,
  splitWorkflowUri,
} from "./certificate.js";
import { lookupRegistryKey, type RegistryKey } from "./keys.js";
import {
  checkSubject,
  decodeStatement,
  GITHUB_BUILDER_ID_PREFIX,
  type InTotoStatement,
  NPM_PUBLISH_ATTESTATION_V01,
  parseGithubPredicate,
  SLSA_PROVENANCE_PREFIX,
} from "./predicate.js";
import type {
  CertificateIdentity,
  Mismatch,
  PredicateClaim,
  ProvenanceResult,
  ProvenanceStatus,
  PublishAttestationResult,
} from "./types.js";

type SerializedBundle = Parameters<typeof verify>[0];
type SigstoreVerifyOptions = NonNullable<Parameters<typeof verify>[2]>;

const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;

export interface BundleVerifyOptions {
  tufCachePath?: string | undefined;
  tufForceCache?: boolean | undefined;
  keySelector?: ((hint: string) => string | undefined) | undefined;
}

/**
 * Verifies a bundle's signature against the Sigstore trust root (or a registry key) and
 * returns the signer's identity. Defaults to sigstore; injectable so tests run offline.
 */
export type BundleVerifier = (
  bundle: SerializedBundle,
  options: BundleVerifyOptions,
) => Promise<{ identity?: SignerIdentityLike | undefined }>;

const sigstoreVerifier: BundleVerifier = async (bundle, options) => {
  const verifyOptions: SigstoreVerifyOptions = {};
  if (options.tufCachePath !== undefined) {
    verifyOptions.tufCachePath = options.tufCachePath;
  }
  if (options.tufForceCache !== undefined) {
    verifyOptions.tufForceCache = options.tufForceCache;
  }
  if (options.keySelector !== undefined) {
    verifyOptions.keySelector = options.keySelector;
  }
  const signer = await verify(bundle, verifyOptions);
  return { identity: signer.identity };
};

export interface VerifyProvenanceInput {
  purl: string;
  /** Hex SHA-512 of the tarball we actually downloaded. */
  sha512Hex: string;
  attestations: AttestationsResponse | null;
}

export interface VerifyProvenanceOptions {
  verifier?: BundleVerifier | undefined;
  /** Registry signing keys for the publish attestation. Null or undefined means unavailable. */
  registryKeys?: RegistryKey[] | null | undefined;
  tufCachePath?: string | undefined;
  /** Use the cached Sigstore trust root without refreshing it over the network. */
  offline?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBundleLike(
  bundle: Record<string, unknown>,
): bundle is Record<string, unknown> & SerializedBundle {
  return (
    typeof bundle.mediaType === "string" &&
    isRecord(bundle.verificationMaterial) &&
    isRecord(bundle.dsseEnvelope)
  );
}

function fail(
  result: ProvenanceResult,
  status: ProvenanceStatus,
  problem: string,
): ProvenanceResult {
  result.status = status;
  result.problems.push(problem);
  return result;
}

function readKeyHint(bundle: Record<string, unknown>): string | undefined {
  const material = bundle.verificationMaterial;
  const publicKey = isRecord(material) ? material.publicKey : undefined;
  return isRecord(publicKey) && typeof publicKey.hint === "string" ? publicKey.hint : undefined;
}

function readTransparencyLog(bundle: Record<string, unknown>): ProvenanceResult["transparencyLog"] {
  const material = bundle.verificationMaterial;
  const entries = isRecord(material) ? material.tlogEntries : undefined;
  const first = Array.isArray(entries) ? entries[0] : undefined;
  if (!isRecord(first)) {
    return undefined;
  }
  const { logIndex, integratedTime } = first;
  if (
    (typeof logIndex !== "string" && typeof logIndex !== "number") ||
    (typeof integratedTime !== "string" && typeof integratedTime !== "number")
  ) {
    return undefined;
  }
  return { logIndex: String(logIndex), integratedTime: String(integratedTime) };
}

/**
 * When a key-signed bundle was signed, from its transparency log entry. Only an entry with a
 * signed entry timestamp counts: Rekor signs `integratedTime` there, and sigstore verifies that
 * signature with the bundle, so a forged time fails verification. An inclusion proof alone does
 * not cover the time, so it gives undefined, and the caller falls back to "valid now".
 */
export function signedLogTime(bundle: Record<string, unknown>): Date | undefined {
  const material = bundle.verificationMaterial;
  const entries = isRecord(material) ? material.tlogEntries : undefined;
  const first = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  if (!isRecord(first) || !isRecord(first.inclusionPromise)) {
    return undefined;
  }
  const { signedEntryTimestamp } = first.inclusionPromise;
  const time = first.integratedTime;
  if (typeof signedEntryTimestamp !== "string" || signedEntryTimestamp === "") {
    return undefined;
  }
  if (!(typeof time === "string" && /^\d{1,12}$/.test(time)) && !Number.isSafeInteger(time)) {
    return undefined;
  }
  const seconds = Number(time);
  return seconds > 0 ? new Date(seconds * 1000) : undefined;
}

/** Every field where the job's claim disagrees with what the certificate attests. */
export function crossCheck(certificate: CertificateIdentity, claim: PredicateClaim): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const compare = (field: string, fromCertificate?: string, fromPredicate?: string) => {
    if (
      fromCertificate !== undefined &&
      fromPredicate !== undefined &&
      fromCertificate !== fromPredicate
    ) {
      mismatches.push({ field, certificate: fromCertificate, predicate: fromPredicate });
    }
  };
  compare("repository", certificate.sourceRepositoryUri, claim.repository);
  compare("commit", certificate.sourceRepositoryDigest, claim.commit);
  if (claim.sourceRef === undefined) {
    const expected =
      certificate.sourceRepositoryUri && certificate.sourceRepositoryRef
        ? `git+${certificate.sourceRepositoryUri}@${certificate.sourceRepositoryRef}`
        : undefined;
    compare("source", expected, claim.sourceUri);
  } else {
    compare("ref", certificate.sourceRepositoryRef, claim.sourceRef);
  }
  compare(
    "workflow",
    certificate.buildConfigUri,
    `${claim.repository}/${claim.workflowPath}@${claim.workflowRef}`,
  );
  compare("trigger", certificate.buildTrigger, claim.eventName);
  compare("invocation", certificate.runInvocationUri, claim.invocationId);
  compare("repositoryId", certificate.sourceRepositoryId, claim.repositoryId);
  compare("ownerId", certificate.sourceRepositoryOwnerId, claim.repositoryOwnerId);
  if (certificate.runnerEnvironment !== undefined) {
    compare(
      "builder",
      `${GITHUB_BUILDER_ID_PREFIX}${certificate.runnerEnvironment}`,
      claim.builderId,
    );
  }
  return mismatches;
}

async function verifyPublishAttestation(
  entries: AttestationEntry[],
  input: VerifyProvenanceInput,
  options: VerifyProvenanceOptions,
  verifier: BundleVerifier,
  bundleOptions: BundleVerifyOptions,
): Promise<PublishAttestationResult> {
  const invalid = (problem: string): PublishAttestationResult => ({ status: "invalid", problem });
  const [entry] = entries;
  if (!entry) {
    return { status: "missing" };
  }
  if (entries.length > 1) {
    return invalid(`expected one publish attestation, found ${entries.length}`);
  }
  let statement: InTotoStatement;
  try {
    statement = decodeStatement(entry.bundle);
  } catch (error) {
    return invalid(`publish attestation is malformed: ${errorMessage(error)}`);
  }
  if (statement.predicateType !== NPM_PUBLISH_ATTESTATION_V01) {
    return invalid(`signed publish statement has predicate type ${statement.predicateType}`);
  }
  const subjectProblem = checkSubject(statement, input);
  if (subjectProblem) {
    return invalid(`publish attestation ${subjectProblem}`);
  }
  if (!isBundleLike(entry.bundle)) {
    return invalid("publish attestation bundle is malformed");
  }
  const hint = readKeyHint(entry.bundle);
  if (!hint) {
    return invalid("publish attestation is not signed with a registry key");
  }
  if (!options.registryKeys) {
    return invalid("registry signing keys were not available");
  }
  // The key only has to be valid when the registry signed, not today (npm rotates its keys).
  const lookup = lookupRegistryKey(options.registryKeys, hint, signedLogTime(entry.bundle));
  if (!lookup.ok) {
    return invalid(lookup.problem);
  }
  try {
    await verifier(entry.bundle, {
      ...bundleOptions,
      keySelector: (candidate) => (candidate === hint ? lookup.pem : undefined),
    });
  } catch (error) {
    return invalid(`publish attestation signature verification failed: ${errorMessage(error)}`);
  }
  return { status: "verified", keyid: hint };
}

async function verifyProvenanceEntry(
  entry: AttestationEntry,
  input: VerifyProvenanceInput,
  result: ProvenanceResult,
  verifier: BundleVerifier,
  bundleOptions: BundleVerifyOptions,
): Promise<ProvenanceResult> {
  let statement: InTotoStatement;
  try {
    statement = decodeStatement(entry.bundle);
  } catch (error) {
    return fail(result, "invalid", `provenance attestation is malformed: ${errorMessage(error)}`);
  }
  if (statement.predicateType !== entry.predicateType) {
    return fail(
      result,
      "invalid",
      `registry lists predicate type ${entry.predicateType} but the signed statement says ${statement.predicateType}`,
    );
  }
  const subjectProblem = checkSubject(statement, input);
  if (subjectProblem) {
    return fail(result, "invalid", `provenance ${subjectProblem}`);
  }
  const parsed = parseGithubPredicate(statement);
  if (!parsed.ok) {
    return fail(
      result,
      parsed.status,
      parsed.status === "unsupported"
        ? `unsupported provenance: ${parsed.reason}`
        : `invalid provenance: ${parsed.reason}`,
    );
  }
  result.predicate = parsed.claim;
  if (!isBundleLike(entry.bundle)) {
    return fail(result, "invalid", "provenance bundle is malformed");
  }

  let identity: SignerIdentityLike | undefined;
  try {
    ({ identity } = await verifier(entry.bundle, bundleOptions));
  } catch (error) {
    return fail(
      result,
      "invalid",
      `provenance signature verification failed: ${errorMessage(error)}`,
    );
  }
  if (!identity) {
    return fail(result, "invalid", "provenance was not signed with a certificate");
  }
  const certificate = extractCertificateIdentity(identity);
  result.certificate = certificate;
  if (certificate.issuer !== GITHUB_ACTIONS_ISSUER) {
    return fail(
      result,
      "unsupported",
      `provenance certificate issuer ${certificate.issuer ?? "(none)"} is not GitHub Actions`,
    );
  }
  const { sourceRepositoryUri, sourceRepositoryDigest, sourceRepositoryRef, buildConfigUri } =
    certificate;
  if (!sourceRepositoryUri || !sourceRepositoryDigest || !sourceRepositoryRef || !buildConfigUri) {
    return fail(
      result,
      "invalid",
      "provenance certificate lacks the source repository, commit, ref or workflow",
    );
  }
  if (!GIT_COMMIT_RE.test(sourceRepositoryDigest)) {
    return fail(
      result,
      "invalid",
      `certificate source digest "${sourceRepositoryDigest}" is not a git commit`,
    );
  }
  const workflow = splitWorkflowUri(buildConfigUri, sourceRepositoryUri);
  if (!workflow) {
    return fail(
      result,
      "invalid",
      `build config ${buildConfigUri} is not a workflow of ${sourceRepositoryUri}`,
    );
  }

  result.transparencyLog = readTransparencyLog(entry.bundle);
  result.mismatches = crossCheck(certificate, parsed.claim);
  const signerUri = certificate.buildSignerUri ?? certificate.subjectAlternativeName;
  if (signerUri && !signerUri.startsWith(`${sourceRepositoryUri}/`)) {
    result.signerOutsideRepository = signerUri;
  }
  result.source = {
    repository: sourceRepositoryUri,
    commit: sourceRepositoryDigest,
    ref: sourceRepositoryRef,
    workflowPath: workflow.path,
    workflowRef: workflow.ref,
    trigger: certificate.buildTrigger,
    runnerEnvironment: certificate.runnerEnvironment,
    invocationUri: certificate.runInvocationUri,
    visibility: certificate.sourceRepositoryVisibility,
    repositoryId: certificate.sourceRepositoryId,
    ownerUri: certificate.sourceRepositoryOwnerUri,
  };
  result.status = "verified";
  return result;
}

/**
 * Verifies the attestations of one tarball. Never throws for bad attestations: every
 * failure becomes a `missing`, `invalid` or `unsupported` status with the reason, so the
 * caller can fail closed and still show the user what was found.
 */
export async function verifyProvenance(
  input: VerifyProvenanceInput,
  options: VerifyProvenanceOptions = {},
): Promise<ProvenanceResult> {
  const verifier = options.verifier ?? sigstoreVerifier;
  const bundleOptions: BundleVerifyOptions = {
    tufCachePath: options.tufCachePath,
    tufForceCache: options.offline,
  };
  const result: ProvenanceResult = {
    status: "missing",
    problems: [],
    warnings: [],
    mismatches: [],
    publishAttestation: { status: "missing" },
  };

  const entries = input.attestations?.attestations ?? [];
  if (entries.length === 0) {
    result.problems.push("the registry has no attestations for this version");
    return result;
  }
  const publishEntries: AttestationEntry[] = [];
  const provenanceEntries: AttestationEntry[] = [];
  for (const entry of entries) {
    if (entry.predicateType === NPM_PUBLISH_ATTESTATION_V01) {
      publishEntries.push(entry);
    } else if (entry.predicateType.startsWith(SLSA_PROVENANCE_PREFIX)) {
      provenanceEntries.push(entry);
    } else {
      result.warnings.push(
        `ignored attestation with unknown predicate type ${entry.predicateType}`,
      );
    }
  }

  result.publishAttestation = await verifyPublishAttestation(
    publishEntries,
    input,
    options,
    verifier,
    bundleOptions,
  );

  const [entry] = provenanceEntries;
  if (!entry) {
    result.problems.push("the registry has no provenance attestation for this version");
    return result;
  }
  if (provenanceEntries.length > 1) {
    return fail(
      result,
      "invalid",
      `expected one provenance attestation, found ${provenanceEntries.length}`,
    );
  }
  return verifyProvenanceEntry(entry, input, result, verifier, bundleOptions);
}
