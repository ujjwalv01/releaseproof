/**
 * `verified`: a Sigstore certificate chained to the public trust root signed the provenance
 *   and the subject matches this tarball. `source` is then trustworthy.
 * `missing`: the registry has no provenance for this version.
 * `invalid`: provenance exists but a check failed. Treat like an attack until proven otherwise.
 * `unsupported`: provenance exists but is a format v1 cannot interpret (not GitHub Actions).
 * Only `verified` can ever contribute to a "MATCHES SOURCE" verdict.
 */
export type ProvenanceStatus = "verified" | "missing" | "invalid" | "unsupported";

/** Facts about the build taken from the Fulcio certificate (issued from GitHub's OIDC token). */
export interface CertificateIdentity {
  subjectAlternativeName?: string | undefined;
  issuer?: string | undefined;
  buildSignerUri?: string | undefined;
  buildSignerDigest?: string | undefined;
  runnerEnvironment?: string | undefined;
  sourceRepositoryUri?: string | undefined;
  sourceRepositoryDigest?: string | undefined;
  sourceRepositoryRef?: string | undefined;
  sourceRepositoryId?: string | undefined;
  sourceRepositoryOwnerUri?: string | undefined;
  sourceRepositoryOwnerId?: string | undefined;
  buildConfigUri?: string | undefined;
  buildConfigDigest?: string | undefined;
  buildTrigger?: string | undefined;
  runInvocationUri?: string | undefined;
  sourceRepositoryVisibility?: string | undefined;
  deploymentEnvironment?: string | undefined;
  tokenSubject?: string | undefined;
}

/** What the build job wrote into the SLSA predicate. A claim, built from env vars in the job. */
export interface PredicateClaim {
  buildType: string;
  repository: string;
  workflowPath: string;
  workflowRef: string;
  eventName?: string | undefined;
  repositoryId?: string | undefined;
  repositoryOwnerId?: string | undefined;
  sourceUri: string;
  /** The ref part of `sourceUri` when it has the expected `git+<repository>@<ref>` form. */
  sourceRef?: string | undefined;
  commit: string;
  builderId: string;
  invocationId?: string | undefined;
}

/** The source a verified provenance vouches for. Taken from the certificate, not the claim. */
export interface VerifiedSource {
  repository: string;
  commit: string;
  ref: string;
  workflowPath?: string | undefined;
  workflowRef?: string | undefined;
  trigger?: string | undefined;
  runnerEnvironment?: string | undefined;
  invocationUri?: string | undefined;
  visibility?: string | undefined;
  repositoryId?: string | undefined;
  ownerUri?: string | undefined;
}

export interface Mismatch {
  field: string;
  certificate: string | undefined;
  predicate: string | undefined;
}

export interface PublishAttestationResult {
  status: "verified" | "missing" | "invalid";
  keyid?: string | undefined;
  problem?: string | undefined;
}

export interface ProvenanceResult {
  status: ProvenanceStatus;
  /** Why the status is not `verified`. Empty when it is. */
  problems: string[];
  /** Things worth showing that do not change the status. */
  warnings: string[];
  source?: VerifiedSource | undefined;
  certificate?: CertificateIdentity | undefined;
  predicate?: PredicateClaim | undefined;
  /** Fields where the job's claim disagrees with the certificate. Each one is a finding. */
  mismatches: Mismatch[];
  /** Set when the signing workflow lives outside the source repository (reusable workflow). */
  signerOutsideRepository?: string | undefined;
  publishAttestation: PublishAttestationResult;
  transparencyLog?: { logIndex: string; integratedTime: string } | undefined;
  /**
   * `rekor` when the registry hid the provenance (a staged version) and it was found in the
   * transparency log by the tarball's digest instead. Absent when the registry served it.
   */
  attestationSource?: "rekor" | undefined;
}
