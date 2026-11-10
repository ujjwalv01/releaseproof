import { type RegistryOptions, registryJson } from "../registry/client.js";

/** One entry of `GET /-/npm/v1/keys`. */
export interface RegistryKey {
  keyid: string;
  /** Base64 SPKI public key. */
  key: string;
  keytype?: string | undefined;
  scheme?: string | undefined;
  /** ISO date after which the key must not be used, or null. */
  expires?: string | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a keys response. Null when malformed: a half-trusted key list is worse than none. */
export function readRegistryKeys(body: unknown): RegistryKey[] | null {
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    return null;
  }
  const keys: RegistryKey[] = [];
  for (const entry of body.keys) {
    if (!isRecord(entry) || typeof entry.keyid !== "string" || typeof entry.key !== "string") {
      return null;
    }
    // Only an absent or null expiry means "never expires". Any other value must be a date
    // string that parses; a number, boolean, object or unparseable string rejects the list.
    const { expires } = entry;
    if (
      expires !== undefined &&
      expires !== null &&
      (typeof expires !== "string" || !Number.isFinite(Date.parse(expires)))
    ) {
      return null;
    }
    keys.push({
      keyid: entry.keyid,
      key: entry.key,
      keytype: typeof entry.keytype === "string" ? entry.keytype : undefined,
      scheme: typeof entry.scheme === "string" ? entry.scheme : undefined,
      expires: typeof entry.expires === "string" ? entry.expires : null,
    });
  }
  return keys;
}

/** Fetches the registry's signing keys. Null when the registry has none or the response is malformed. */
export async function fetchRegistryKeys(
  options: RegistryOptions = {},
): Promise<RegistryKey[] | null> {
  const body = await registryJson<unknown>("/-/npm/v1/keys", options);
  return body === null ? null : readRegistryKeys(body);
}

export type KeyLookup = { ok: true; pem: string } | { ok: false; problem: string };

/**
 * Finds a usable key by keyid. A key that expires is still valid for signatures made before
 * its expiry, as `npm audit signatures` treats it: npm rotates keys, and every attestation
 * signed with the old key stays valid. `signedAt` must be a time the caller can trust
 * (verified by the transparency log); without one, the key must still be valid now.
 */
export function lookupRegistryKey(
  keys: RegistryKey[],
  keyid: string,
  signedAt: Date = new Date(),
): KeyLookup {
  const key = keys.find((candidate) => candidate.keyid === keyid);
  if (!key) {
    return { ok: false, problem: `the registry has no signing key with keyid ${keyid}` };
  }
  if (key.expires && new Date(key.expires).getTime() <= signedAt.getTime()) {
    return {
      ok: false,
      problem: `registry signing key ${keyid} expired on ${key.expires}, before ${signedAt.toISOString()}`,
    };
  }
  return { ok: true, pem: `-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----\n` };
}
