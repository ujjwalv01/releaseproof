import { describe, expect, it } from "vitest";
import { RELEASEPROOF_011, releaseproofAttestations } from "../../test/fixtures.js";
import { extractCertificateIdentity } from "./certificate.js";
import { decodeDerUtf8String, encodeDerUtf8String, readCertificateExtensions } from "./der.js";
import { SLSA_PROVENANCE_V1 } from "./predicate.js";

describe("DER UTF8String", () => {
  it("round-trips short-form lengths", () => {
    const encoded = encodeDerUtf8String("push");
    expect([...encoded]).toEqual([0x0c, 4, 0x70, 0x75, 0x73, 0x68]);
    expect(decodeDerUtf8String(encoded)).toBe("push");
  });

  it("round-trips long-form lengths (128 bytes and up)", () => {
    const value = "x".repeat(200);
    const encoded = encodeDerUtf8String(value);
    expect([...encoded.subarray(0, 3)]).toEqual([0x0c, 0x81, 200]);
    expect(decodeDerUtf8String(encoded)).toBe(value);

    const longer = "y".repeat(70_000);
    expect(decodeDerUtf8String(encodeDerUtf8String(longer))).toBe(longer);
  });

  it("decodes the empty string and multi-byte UTF-8", () => {
    expect(decodeDerUtf8String(Buffer.from([0x0c, 0x00]))).toBe("");
    expect(decodeDerUtf8String(encodeDerUtf8String("héllo ✓"))).toBe("héllo ✓");
  });

  it.each([
    ["wrong tag (PrintableString)", [0x13, 0x01, 0x41]],
    ["raw string without DER framing", [0x70, 0x75, 0x73, 0x68]],
    ["truncated body", [0x0c, 0x05, 0x41]],
    ["trailing bytes", [0x0c, 0x01, 0x41, 0x42]],
    ["indefinite length", [0x0c, 0x80, 0x41]],
    ["too many length bytes", [0x0c, 0x85, 0, 0, 0, 0, 1, 0x41]],
    ["empty input", []],
  ])("returns undefined for %s", (_name, bytes) => {
    expect(decodeDerUtf8String(Buffer.from(bytes))).toBeUndefined();
  });
});

describe("readCertificateExtensions", () => {
  const certificate = () => {
    const attestations = releaseproofAttestations().attestations;
    const bundle = attestations.find((a) => a.predicateType === SLSA_PROVENANCE_V1)?.bundle as {
      verificationMaterial: { certificate: { rawBytes: string } };
    };
    return Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64");
  };

  it("reads the Fulcio extensions of a real certificate", () => {
    const oids = readCertificateExtensions(certificate()) ?? [];
    const identity = extractCertificateIdentity({ oids });
    expect(identity).toMatchObject({
      issuer: "https://token.actions.githubusercontent.com",
      sourceRepositoryUri: RELEASEPROOF_011.repository,
      sourceRepositoryDigest: RELEASEPROOF_011.commit,
      sourceRepositoryRef: "refs/heads/main",
      buildTrigger: "push",
      runnerEnvironment: "github-hosted",
    });
    // Standard extensions are listed too: key usage is 2.5.29.15.
    expect(oids.map((entry) => entry.oid.id.join("."))).toContain("2.5.29.15");
  });

  it("returns undefined for anything that is not a well-formed certificate", () => {
    const der = certificate();
    expect(readCertificateExtensions(Buffer.from("not DER"))).toBeUndefined();
    expect(readCertificateExtensions(der.subarray(0, der.length - 1))).toBeUndefined();
    expect(readCertificateExtensions(Buffer.concat([der, Buffer.from([0])]))).toBeUndefined();
    expect(readCertificateExtensions(Buffer.from([]))).toBeUndefined();
  });
});
