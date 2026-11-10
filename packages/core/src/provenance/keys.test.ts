import { describe, expect, it } from "vitest";
import { SIGSTORE_5, sigstoreKeys } from "../../test/fixtures.js";
import { lookupRegistryKey, readRegistryKeys } from "./keys.js";

describe("readRegistryKeys", () => {
  it("reads the real keys response", () => {
    const keys = readRegistryKeys({ keys: sigstoreKeys() });
    expect(keys).toHaveLength(2);
    expect(keys?.[1]).toMatchObject({
      keyid: SIGSTORE_5.keyid,
      expires: null,
      keytype: "ecdsa-sha2-nistp256",
    });
    expect(keys?.[0]?.expires).toBe("2025-01-29T00:00:00.000Z");
  });

  it("returns null for a malformed response", () => {
    expect(readRegistryKeys({ keys: [{ keyid: "x" }] })).toBeNull();
    expect(readRegistryKeys({})).toBeNull();
    expect(readRegistryKeys("nope")).toBeNull();
  });

  it.each(["2027-01-29T00:00:00.000Z", null, undefined])(
    "accepts a valid or absent expiry: %s",
    (expires) => {
      const keys = readRegistryKeys({
        keys: [
          { keyid: "current", key: "public-key", ...(expires === undefined ? {} : { expires }) },
        ],
      });
      expect(keys).toHaveLength(1);
      expect(keys?.[0]?.expires).toBe(expires ?? null);
      expect(
        lookupRegistryKey(keys ?? [], "current", new Date("2026-01-01T00:00:00Z")),
      ).toMatchObject({
        ok: true,
      });
    },
  );

  it.each([
    "soon",
    "2025-13-45",
    "",
    1_700_000_000_000,
    0,
    true,
    false,
    {},
    ["2027-01-29T00:00:00.000Z"],
  ])("rejects the entire list for invalid expiry %j", (expires) => {
    expect(
      readRegistryKeys({
        keys: [
          { keyid: "valid", key: "public-key", expires: null },
          { keyid: "invalid", key: "public-key", expires },
        ],
      }),
    ).toBeNull();
  });
});

describe("lookupRegistryKey", () => {
  const keys = sigstoreKeys();
  const now = new Date("2026-10-17T00:00:00Z");

  it("returns the PEM for a current key", () => {
    const lookup = lookupRegistryKey(keys, SIGSTORE_5.keyid, now);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.pem).toMatch(/^-----BEGIN PUBLIC KEY-----\nMFkw/);
    }
  });

  it("refuses a key that had expired when the signature was made", () => {
    expect(
      lookupRegistryKey(keys, "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA", now),
    ).toEqual({
      ok: false,
      problem:
        "registry signing key SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA expired on 2025-01-29T00:00:00.000Z, before 2026-10-17T00:00:00.000Z",
    });
  });

  it("accepts a rotated key for signatures made before it expired, as npm does", () => {
    const oldKey = "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA";
    // sigstore@2.0.0's publish attestation was logged on 2023-08-18 with this key.
    expect(lookupRegistryKey(keys, oldKey, new Date("2023-08-18T15:25:38Z")).ok).toBe(true);
    expect(lookupRegistryKey(keys, oldKey, new Date("2025-01-28T23:59:59Z")).ok).toBe(true);
    expect(lookupRegistryKey(keys, oldKey, new Date("2025-01-29T00:00:00Z")).ok).toBe(false);
  });

  it("checks against the current time when no signing time is given", () => {
    expect(lookupRegistryKey(keys, "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA").ok).toBe(
      false,
    );
  });

  it("refuses an unknown keyid", () => {
    expect(lookupRegistryKey(keys, "SHA256:unknown", now)).toMatchObject({ ok: false });
  });
});
