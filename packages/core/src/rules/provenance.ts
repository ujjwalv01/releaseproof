import { normalizeGithubRepository } from "./repository.js";
import type { Finding, RuleContext } from "./types.js";

/** Events that only legitimately publish from trusted, maintainer-controlled refs. */
const USUAL_TRIGGERS = new Set(["push", "release", "workflow_dispatch", "create", "schedule"]);

/** Findings about where the release claims to come from. */
export function provenanceRules(context: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const { provenance } = context;

  switch (provenance.status) {
    case "invalid":
      findings.push({
        id: "provenance-invalid",
        severity: "critical",
        title: "provenance does not verify",
        detail: `${provenance.problems.join("; ")}. The registry serves an attestation for this version that does not check out, which should never happen for an honest release.`,
        evidence: { problems: provenance.problems },
      });
      break;
    case "unsupported":
      findings.push({
        id: "provenance-unsupported",
        severity: "medium",
        title: "provenance is in a format releaseproof cannot interpret",
        detail: `${provenance.problems.join("; ")}. Only GitHub Actions provenance is supported in this version.`,
        evidence: { problems: provenance.problems },
      });
      break;
    case "missing":
      findings.push({
        id: "provenance-missing",
        severity: "medium",
        title: "no provenance",
        detail:
          context.origin === "staged"
            ? "Staged versions do not expose attestations before approval, so the source could not be certified."
            : "The registry has no provenance for this version, so nothing certifies which commit it was built from.",
      });
      break;
    default:
      break;
  }

  if (provenance.mismatches.length > 0) {
    findings.push({
      id: "provenance-claim-mismatch",
      severity: "critical",
      title: "the build's own claim disagrees with its certificate",
      detail:
        "The SLSA predicate is written by the build job from environment variables; the certificate comes from GitHub's OIDC token and cannot be changed by the job. They differ, which means the job lied about where it built from: " +
        provenance.mismatches
          .map(
            (m) =>
              `${m.field} (certificate ${m.certificate ?? "none"}, claim ${m.predicate ?? "none"})`,
          )
          .join("; "),
      evidence: { mismatches: provenance.mismatches },
    });
  }

  const source = provenance.source;
  if (source) {
    const certified = normalizeGithubRepository(source.repository);
    const expected = normalizeGithubRepository(context.expectations.repository);
    if (context.expectations.repository && certified !== expected) {
      findings.push({
        id: "provenance-repository-unexpected",
        severity: "critical",
        title: `built from ${source.repository}, not the repository you expected`,
        detail: `You expected ${context.expectations.repository}. A release built from another repository is not your release.`,
        evidence: { certified: source.repository, expected: context.expectations.repository },
      });
    }
    const manifest = normalizeGithubRepository(context.manifestRepository);
    if (manifest && certified && manifest !== certified) {
      findings.push({
        id: "provenance-repository-differs-from-manifest",
        severity: "high",
        title: `built from ${source.repository}, but package.json says ${context.manifestRepository}`,
        detail:
          "The certified source repository is not the one the package declares. Legitimate for forks and moved repositories; also what a hijacked trusted-publisher configuration looks like.",
        evidence: { certified: source.repository, manifest: context.manifestRepository },
      });
    }
    if (source.trigger && !USUAL_TRIGGERS.has(source.trigger)) {
      findings.push({
        id: "provenance-trigger-unusual",
        severity: "high",
        title: `published from a "${source.trigger}" workflow run`,
        detail:
          "Releases normally come from push, release or workflow_dispatch events. Pull-request style events run with contributor-controlled input; a publish from one of them is the TanStack attack pattern.",
        evidence: { trigger: source.trigger },
      });
    }
    if (!/^refs\/(heads|tags)\//.test(source.ref)) {
      findings.push({
        id: "provenance-ref-unusual",
        severity: "high",
        title: `built from ref ${source.ref}`,
        detail: "Not a branch or a tag. refs/pull/… refs contain contributor-controlled code.",
        evidence: { ref: source.ref },
      });
    }
    if (source.runnerEnvironment && source.runnerEnvironment !== "github-hosted") {
      findings.push({
        id: "provenance-runner-self-hosted",
        severity: "low",
        title: `built on a ${source.runnerEnvironment} runner`,
        detail: "Self-hosted runners are only as clean as the machine they run on.",
        evidence: { runnerEnvironment: source.runnerEnvironment },
      });
    }
  }

  if (provenance.signerOutsideRepository) {
    findings.push({
      id: "provenance-signer-outside-repository",
      severity: "medium",
      title: "signed by a workflow in another repository",
      detail: `The signing workflow is ${provenance.signerOutsideRepository}. Shared reusable release workflows do this legitimately; make sure it is one you trust, because it had the publish token.`,
      evidence: { signer: provenance.signerOutsideRepository },
    });
  }

  if (provenance.status === "verified") {
    const publish = provenance.publishAttestation;
    if (publish.status === "invalid") {
      findings.push({
        id: "publish-attestation-invalid",
        severity: "high",
        title: "the registry's publish attestation does not verify",
        detail: publish.problem ?? "unknown problem",
      });
    } else if (publish.status === "missing" && context.origin !== "staged") {
      // A staged version gets its publish attestation when it is approved, not before.
      findings.push({
        id: "publish-attestation-missing",
        severity: "low",
        title: "no publish attestation from the registry",
        detail:
          "The registry did not attest that it published this tarball. Provenance still verifies.",
      });
    }
  }
  for (const warning of provenance.warnings) {
    findings.push({ id: "provenance-note", severity: "info", title: warning, detail: warning });
  }
  return findings;
}
