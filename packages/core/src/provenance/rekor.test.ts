import { describe, expect, it, vi } from "vitest";
import {
  RELEASEPROOF_011,
  releaseproofAttestations,
  releaseproofRekorEntry,
} from "../../test/fixtures.js";
import { ToolError } from "../errors.js";
import type { AttestationEntry } from "../fetch/types.js";
import type { SignerIdentityLike } from "./certificate.js";
import { readCertificateExtensions } from "./der.js";
import { SLSA_PROVENANCE_V1 } from "./predicate.js";
import {
  bundleFromRekorEntry,
  findRekorAttestations,
  findRekorProvenance,
  MAX_REKOR_ENTRIES,
  npmGithubStatement,
  type RekorCandidates,
} from "./rekor.js";
import type { BundleVerifier } from "./verify.js";

const subject = { purl: RELEASEPROOF_011.purl, sha512Hex: RELEASEPROOF_011.sha512Hex };

function registryBundle(predicateType: string): Record<string, unknown> {
  const entry = releaseproofAttestations().attestations.find((a) =>
    a.predicateType.startsWith(predicateType),
  );
  if (!entry) {
    throw new Error(`fixture has no ${predicateType} attestation`);
  }
  return entry.bundle;
}

function realEntry(): Record<string, unknown> {
  const entry = releaseproofRekorEntry()[RELEASEPROOF_011.rekorUuid];
  if (!entry) {
    throw new Error("fixture has no Rekor entry");
  }
  return entry;
}

function certificateDer(): Buffer {
  const material = registryBundle(SLSA_PROVENANCE_V1).verificationMaterial as {
    certificate: { rawBytes: string };
  };
  return Buffer.from(material.certificate.rawBytes, "base64");
}

function realPayload(): Buffer {
  const envelope = registryBundle(SLSA_PROVENANCE_V1).dsseEnvelope as { payload: string };
  return Buffer.from(envelope.payload, "base64");
}

/** The certificate identity sigstore would report for the real provenance bundle. */
function realIdentity(): SignerIdentityLike {
  return { oids: readCertificateExtensions(certificateDer()) ?? [] };
}

/** A Rekor API entry whose body has been edited (other fields untouched). */
function withBody(edit: (body: Record<string, unknown>) => void): Record<string, unknown> {
  const entry = realEntry();
  const body = JSON.parse(Buffer.from(entry.body as string, "base64").toString("utf8"));
  edit(body);
  return { ...entry, body: Buffer.from(JSON.stringify(body)).toString("base64") };
}

interface FakeRekor {
  fetch: typeof fetch;
  requests: Array<{ url: string; method: string; body: unknown }>;
}

function fakeRekor(
  search: unknown,
  entries: Record<string, unknown> = {},
  status = 200,
): FakeRekor {
  const requests: FakeRekor["requests"] = [];
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    requests.push({
      url: href,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (status !== 200) {
      return new Response("nope", { status });
    }
    if (href.endsWith("/api/v1/index/retrieve")) {
      return Response.json(search);
    }
    const uuid = href.split("/").pop() ?? "";
    return Response.json({ [uuid]: entries[uuid] });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

describe("npmGithubStatement", () => {
  it("rebuilds the exact statement npm signed from the certificate", () => {
    const rebuilt = npmGithubStatement(certificateDer(), subject);
    expect(rebuilt?.toString("utf8")).toBe(realPayload().toString("utf8"));
  });

  it("gives nothing for bytes that are not a certificate", () => {
    expect(npmGithubStatement(Buffer.from("not a certificate"), subject)).toBeUndefined();
  });
});

describe("bundleFromRekorEntry", () => {
  it("turns the real Rekor entry into the bundle the registry serves since approval", () => {
    const converted = bundleFromRekorEntry(realEntry(), subject);
    expect(converted).toEqual({
      logIndex: RELEASEPROOF_011.logIndex,
      bundle: registryBundle(SLSA_PROVENANCE_V1),
    });
  });

  it("skips an entry whose signed statement is about another tarball", () => {
    const converted = bundleFromRekorEntry(realEntry(), {
      ...subject,
      sha512Hex: "00".repeat(64),
    });
    expect(converted).toEqual({
      skipped: `entry ${RELEASEPROOF_011.logIndex} signs a statement that is not npm's provenance for ${subject.purl}`,
    });
  });

  it("uses the statement Rekor stored when its hash is the signed one", () => {
    const entry = { ...realEntry(), attestation: { data: realPayload().toString("base64") } };
    // The purl differs, so the rebuilt statement cannot match; the stored one does, and the
    // subject check after it will reject the bundle.
    const converted = bundleFromRekorEntry(entry, { ...subject, purl: "pkg:npm/other@1.0.0" });
    expect(converted).toMatchObject({
      bundle: { dsseEnvelope: { payload: realPayload().toString("base64") } },
    });
  });

  it("ignores a stored statement whose hash is not the signed one", () => {
    const entry = { ...realEntry(), attestation: { data: Buffer.from("{}").toString("base64") } };
    expect(bundleFromRekorEntry(entry, subject)).toEqual({
      logIndex: RELEASEPROOF_011.logIndex,
      bundle: registryBundle(SLSA_PROVENANCE_V1),
    });
  });

  it("skips entries that are not DSSE attestations signed with a certificate", () => {
    const hashedrekord = withBody((body) => {
      body.kind = "hashedrekord";
    });
    expect(bundleFromRekorEntry(hashedrekord, subject)).toEqual({
      skipped: `entry ${RELEASEPROOF_011.logIndex} is a hashedrekord 0.0.1 entry, not a DSSE attestation`,
    });

    const publicKey = withBody((body) => {
      const spec = body.spec as { signatures: Array<{ verifier: string }> };
      const pem = "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n";
      spec.signatures[0] = { ...spec.signatures[0], verifier: Buffer.from(pem).toString("base64") };
    });
    expect(bundleFromRekorEntry(publicKey, subject)).toEqual({
      skipped: `entry ${RELEASEPROOF_011.logIndex} is not signed with a certificate`,
    });

    const twoSignatures = withBody((body) => {
      const spec = body.spec as { signatures: unknown[] };
      spec.signatures.push(spec.signatures[0]);
    });
    expect(bundleFromRekorEntry(twoSignatures, subject)).toEqual({
      skipped: `entry ${RELEASEPROOF_011.logIndex} is not a single-signature DSSE entry`,
    });
  });

  it.each([
    ["no entry", undefined],
    ["a body that is not base64", { ...realEntry(), body: "%%%" }],
    ["a log index that is not a number", { ...realEntry(), logIndex: "3310501741" }],
    ["a log id that is not hex", { ...realEntry(), logID: "zz" }],
  ])("skips %s", (_label, entry) => {
    expect(bundleFromRekorEntry(entry, subject)).toEqual({ skipped: "malformed log entry" });
  });

  it("skips an entry with a malformed inclusion proof", () => {
    const entry = realEntry();
    const verification = entry.verification as { inclusionProof: Record<string, unknown> };
    verification.inclusionProof.hashes = ["not hex"];
    expect(bundleFromRekorEntry(entry, subject)).toEqual({
      skipped: `entry ${RELEASEPROOF_011.logIndex} has a malformed inclusion proof`,
    });
  });
});

describe("findRekorAttestations", () => {
  it("searches by the tarball's SHA-512 and converts each entry", async () => {
    const rekor = fakeRekor([RELEASEPROOF_011.rekorUuid.toUpperCase()], releaseproofRekorEntry());
    const found = await findRekorAttestations(subject, {
      fetch: rekor.fetch,
      rekorUrl: "https://rekor.example/",
    });

    expect(found.skipped).toEqual([]);
    expect(found.attestations).toEqual([
      {
        predicateType: SLSA_PROVENANCE_V1,
        bundle: registryBundle(SLSA_PROVENANCE_V1),
        logIndex: RELEASEPROOF_011.logIndex,
      },
    ]);
    expect(rekor.requests).toEqual([
      {
        url: "https://rekor.example/api/v1/index/retrieve",
        method: "POST",
        body: { hash: `sha512:${RELEASEPROOF_011.sha512Hex}` },
      },
      {
        url: `https://rekor.example/api/v1/log/entries/${RELEASEPROOF_011.rekorUuid}`,
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("reports nothing found as an empty result", async () => {
    const found = await findRekorAttestations(subject, { fetch: fakeRekor([]).fetch });
    expect(found).toEqual({ attestations: [], skipped: [] });
  });

  it("does not fetch entries with malformed ids or more entries than it checks", async () => {
    const malformed = fakeRekor(["../../etc/passwd"]);
    expect(await findRekorAttestations(subject, { fetch: malformed.fetch })).toEqual({
      attestations: [],
      skipped: ['Rekor returned a malformed entry id "../../etc/passwd"'],
    });
    expect(malformed.requests).toHaveLength(1);

    const many = Array.from({ length: MAX_REKOR_ENTRIES + 1 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const flooded = fakeRekor(many);
    const found = await findRekorAttestations(subject, { fetch: flooded.fetch });
    expect(found.attestations).toEqual([]);
    expect(found.skipped[0]).toMatch(/lists 11 entries for this tarball, more than the 10/);
    expect(flooded.requests).toHaveLength(1);
  });

  it("throws a ToolError when Rekor fails or answers nonsense", async () => {
    await expect(
      findRekorAttestations(subject, { fetch: fakeRekor([], {}, 503).fetch }),
    ).rejects.toThrow(new ToolError("Rekor returned HTTP 503 for api/v1/index/retrieve"));
    await expect(
      findRekorAttestations(subject, { fetch: fakeRekor({ not: "a list" }).fetch }),
    ).rejects.toThrow(/unexpected search result/);
    await expect(
      findRekorAttestations({ ...subject, sha512Hex: "abc" }, { fetch: fakeRekor([]).fetch }),
    ).rejects.toThrow(/Not a SHA-512 digest/);
  });
});

describe("findRekorProvenance", () => {
  const candidate = (logIndex: number, edit?: (bundle: Record<string, unknown>) => void) => {
    const bundle = registryBundle(SLSA_PROVENANCE_V1);
    edit?.(bundle);
    return { predicateType: SLSA_PROVENANCE_V1, bundle, logIndex };
  };
  const finding =
    (attestations: Array<AttestationEntry & { logIndex: number }>, skipped: string[] = []) =>
    async (): Promise<RekorCandidates> => ({ attestations, skipped });
  /** Pretends every signature is valid; reports the given identity per log index. */
  const verifier = (identities: Record<string, SignerIdentityLike> = {}) =>
    vi.fn<BundleVerifier>(async (bundle) => {
      const material = bundle.verificationMaterial as { tlogEntries: Array<{ logIndex: string }> };
      const logIndex = material.tlogEntries[0]?.logIndex ?? "";
      return { identity: identities[logIndex] ?? realIdentity() };
    });

  it("verifies the entry like a registry attestation and marks it as from Rekor", async () => {
    const result = await findRekorProvenance(subject, {
      expectedRepository: "ujjwalv01/releaseproof",
      find: finding([candidate(RELEASEPROOF_011.logIndex)]),
      verifier: verifier(),
    });

    expect(result.notes).toEqual([]);
    expect(result.provenance).toMatchObject({
      status: "verified",
      attestationSource: "rekor",
      mismatches: [],
      problems: [],
      source: {
        repository: RELEASEPROOF_011.repository,
        commit: RELEASEPROOF_011.commit,
        ref: "refs/heads/main",
        workflowPath: ".github/workflows/release.yml",
        trigger: "push",
      },
      transparencyLog: { logIndex: String(RELEASEPROOF_011.logIndex) },
      publishAttestation: { status: "missing" },
    });
  });

  it("ignores an entry built from another repository", async () => {
    const result = await findRekorProvenance(subject, {
      expectedRepository: "https://github.com/someone/else",
      find: finding([candidate(RELEASEPROOF_011.logIndex)]),
      verifier: verifier(),
    });
    expect(result.provenance).toBeUndefined();
    expect(result.notes).toEqual([
      `Rekor entry ${RELEASEPROOF_011.logIndex} was built from ${RELEASEPROOF_011.repository}, not https://github.com/someone/else; ignored`,
    ]);
  });

  it("ignores an entry that does not verify, and keeps the skipped ones as notes", async () => {
    const failing = vi.fn<BundleVerifier>(async () => {
      throw new Error("signature mismatch");
    });
    const result = await findRekorProvenance(subject, {
      expectedRepository: RELEASEPROOF_011.repository,
      find: finding([candidate(RELEASEPROOF_011.logIndex)], ["Rekor entry 7 is a hashedrekord"]),
      verifier: failing,
    });
    expect(result.provenance).toBeUndefined();
    expect(result.notes).toEqual([
      "Rekor entry 7 is a hashedrekord",
      `Rekor entry ${RELEASEPROOF_011.logIndex} is invalid: provenance signature verification failed: signature mismatch`,
    ]);
  });

  it("ignores an entry about another tarball before verifying its signature", async () => {
    const check = verifier();
    const result = await findRekorProvenance(
      { ...subject, sha512Hex: "00".repeat(64) },
      {
        expectedRepository: RELEASEPROOF_011.repository,
        find: finding([candidate(RELEASEPROOF_011.logIndex)]),
        verifier: check,
      },
    );
    expect(result.provenance).toBeUndefined();
    expect(result.notes[0]).toMatch(
      /is invalid: provenance subject sha512 digest .* does not match/,
    );
    expect(check).not.toHaveBeenCalled();
  });

  it("uses nothing when verified entries from the repository name different commits", async () => {
    const other = withBundleCommit("b".repeat(40));
    const result = await findRekorProvenance(subject, {
      expectedRepository: RELEASEPROOF_011.repository,
      find: finding([
        candidate(1, (b) => setLogIndex(b, "1")),
        candidate(2, (b) => setLogIndex(b, "2")),
      ]),
      verifier: verifier({ "2": other }),
    });
    expect(result.provenance).toBeUndefined();
    expect(result.notes).toContain(
      `Rekor has provenance for this tarball from 2 different commits of ${RELEASEPROOF_011.repository}; none is used`,
    );
  });

  it("uses the lowest log index when several verified entries agree", async () => {
    const result = await findRekorProvenance(subject, {
      expectedRepository: RELEASEPROOF_011.repository,
      find: finding([
        candidate(5, (b) => setLogIndex(b, "5")),
        candidate(9, (b) => setLogIndex(b, "9")),
      ]),
      verifier: verifier(),
    });
    expect(result.provenance?.transparencyLog?.logIndex).toBe("5");
  });

  it("says so when Rekor has nothing for the tarball", async () => {
    const result = await findRekorProvenance(subject, {
      expectedRepository: RELEASEPROOF_011.repository,
      find: finding([]),
    });
    expect(result).toEqual({
      provenance: undefined,
      notes: ["the Rekor transparency log has no provenance for this tarball"],
    });
  });
});

/** The real identity with another source commit (OID .13); the predicate keeps the real one. */
function withBundleCommit(commit: string): SignerIdentityLike {
  const identity = realIdentity();
  return {
    ...identity,
    oids: (identity.oids ?? []).map((entry) =>
      entry.oid?.id?.join(".") === "1.3.6.1.4.1.57264.1.13"
        ? { ...entry, value: Buffer.concat([Buffer.from([0x0c, 40]), Buffer.from(commit)]) }
        : entry,
    ),
  };
}

function setLogIndex(bundle: Record<string, unknown>, logIndex: string): void {
  const material = bundle.verificationMaterial as { tlogEntries: Array<{ logIndex: string }> };
  for (const entry of material.tlogEntries) {
    entry.logIndex = logIndex;
  }
}
