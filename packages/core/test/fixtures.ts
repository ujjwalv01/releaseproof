import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AttestationsResponse } from "../src/fetch/types.js";
import type { SignerIdentityLike } from "../src/provenance/certificate.js";
import { encodeDerUtf8String } from "../src/provenance/der.js";
import type { RegistryKey } from "../src/provenance/keys.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixturePath(...parts: string[]): string {
  return path.join(here, "fixtures", ...parts);
}

export function readFixtureJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(fixturePath(...parts), "utf8")) as T;
}

/** Facts about the real sigstore@5.0.0 release the fixtures were captured from. */
export const SIGSTORE_5 = {
  purl: "pkg:npm/sigstore@5.0.0",
  sha512Hex:
    "849a897e81bf7b8a8541a6ae40bd3473a27a16b1cb0462ad905bd6dc96d34881053a12eb4a375233f81677fc9439f628fe0b0445e8535c60b5559597fbd5f80e",
  commit: "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a",
  repository: "https://github.com/sigstore/sigstore-js",
  workflow: "https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main",
  keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
} as const;

export function sigstoreAttestations(): AttestationsResponse {
  return readFixtureJson<AttestationsResponse>("sigstore-5.0.0", "attestations.json");
}

export function sigstoreKeys(): RegistryKey[] {
  return readFixtureJson<{ keys: RegistryKey[] }>("sigstore-5.0.0", "keys.json").keys;
}

interface SignerIdentityFixture {
  subjectAlternativeName: string;
  extensions: { issuer: string };
  oids: Array<{ id: string; valueBase64: string }>;
}

/** The identity sigstore returned for the real provenance bundle, as `verify()` shapes it. */
export function sigstoreSignerIdentity(): SignerIdentityLike {
  const fixture = readFixtureJson<SignerIdentityFixture>("sigstore-5.0.0", "signer-identity.json");
  return {
    subjectAlternativeName: fixture.subjectAlternativeName,
    extensions: fixture.extensions,
    oids: fixture.oids.map((entry) => ({
      oid: { id: entry.id.split(".").map(Number) },
      value: Buffer.from(entry.valueBase64, "base64"),
    })),
  };
}

/** A copy of the identity with one Fulcio extension (by OID suffix) replaced. */
export function withFulcioOid(
  identity: SignerIdentityLike,
  suffix: number,
  value: string,
): SignerIdentityLike {
  const id = `1.3.6.1.4.1.57264.1.${suffix}`;
  return {
    ...identity,
    oids: (identity.oids ?? []).map((entry) =>
      entry.oid?.id?.join(".") === id ? { ...entry, value: encodeDerUtf8String(value) } : entry,
    ),
  };
}

/** A copy of the attestations with the provenance statement edited (signature untouched). */
export function withEditedProvenance(
  attestations: AttestationsResponse,
  edit: (statement: Record<string, unknown>) => void,
): AttestationsResponse {
  const copy = structuredClone(attestations);
  const entry = copy.attestations.find((a) => a.predicateType.startsWith("https://slsa.dev/"));
  if (!entry) {
    throw new Error("fixture has no provenance entry");
  }
  const envelope = entry.bundle.dsseEnvelope as { payload: string };
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  edit(statement);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  return copy;
}

/**
 * releaseproof@0.1.1: staged, checked, then approved. Its provenance was written to Rekor at
 * stage time (logIndex 3310501741) and is the bundle the registry serves since approval.
 */
export const RELEASEPROOF_011 = {
  purl: "pkg:npm/releaseproof@0.1.1",
  sha512Hex:
    "64380e5d43309eab590fcd26b085e5001f4807db83f1e2b5e0e9c79b784b156808a331c2e2c363e1ba5489290863f7adfe066319a46d3fac0da67cf38a747a3c",
  commit: "a75606a8dd1c6369f2563b7b889848d9df8986bb",
  repository: "https://github.com/ujjwalv01/releaseproof",
  logIndex: 3310501741,
  rekorUuid: "108e9186e8c5677a111b04dc48ca27af608ba149d59a4d58e23e5f054206bd18c5168a126dfa727f",
} as const;

export function releaseproofAttestations(): AttestationsResponse {
  return readFixtureJson<AttestationsResponse>("releaseproof-0.1.1", "attestations.json");
}

/**
 * `GET /api/v1/log/entries/{uuid}` for the provenance entry, in Rekor's API shape (hex log
 * id and hashes, numbers for indexes). Written from the tlog entry of the registry's bundle,
 * which sigstore-js built from this response when npm signed.
 */
export function releaseproofRekorEntry(): Record<string, Record<string, unknown>> {
  return readFixtureJson("releaseproof-0.1.1", "rekor-entry.json");
}
