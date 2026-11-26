import { describe, expect, it, vi } from "vitest";
import { sigstoreAttestations } from "../../test/fixtures.js";
import { ToolError } from "../errors.js";
import { SLSA_PROVENANCE_V1 } from "../provenance/predicate.js";
import { computeDigests } from "./digests.js";
import { fetchPublished, readAttestations, readDist, registryRelativePath } from "./published.js";

const tarball = Buffer.from("not really a tarball, but bytes are bytes");
const digests = computeDigests(tarball);
const REGISTRY = "https://registry.npmjs.org/";

function manifestFor(overrides: Record<string, unknown> = {}) {
  return {
    name: "sigstore",
    version: "5.0.0",
    dist: {
      integrity: `sha512-${digests.sha512Base64}`,
      shasum: digests.sha1Hex,
      tarball: "https://registry.npmjs.org/sigstore/-/sigstore-5.0.0.tgz",
      signatures: [{ keyid: "SHA256:key", sig: "MEUC…" }],
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/sigstore@5.0.0",
        provenance: { predicateType: SLSA_PROVENANCE_V1 },
      },
    },
    gitHead: "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a",
    repository: { type: "git", url: "git+https://github.com/sigstore/sigstore-js.git" },
    ...overrides,
  };
}

type Route = () => Response;

/** A fetch that answers by exact URL and records every request. */
function registryFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    const route = routes[String(url)];
    return route ? route() : new Response("no such route", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200): Route =>
  () =>
    new Response(JSON.stringify(body), { status });
const bytes =
  (data: Buffer): Route =>
  () =>
    new Response(data, { status: 200 });

function routesFor(manifest: unknown, options: { registry?: string; tarballData?: Buffer } = {}) {
  const base = options.registry ?? REGISTRY;
  return {
    [`${base}sigstore/5.0.0`]: json(manifest),
    [`${base}sigstore/-/sigstore-5.0.0.tgz`]: bytes(options.tarballData ?? tarball),
    [`${base}-/npm/v1/attestations/sigstore@5.0.0`]: json(sigstoreAttestations()),
  };
}

describe("fetchPublished", () => {
  it("fetches the version document, the tarball and the attestations with the token", async () => {
    const { fetch, calls } = registryFetch(routesFor(manifestFor()));
    const artifact = await fetchPublished("sigstore@5.0.0", {
      fetch,
      token: "tok",
      env: {},
      npmrcPaths: [],
    });

    expect(artifact.origin).toEqual({ kind: "published", registry: REGISTRY });
    expect(artifact.name).toBe("sigstore");
    expect(artifact.purl).toBe("pkg:npm/sigstore@5.0.0");
    expect(artifact.tarball.equals(tarball)).toBe(true);
    expect(artifact.digests).toEqual(digests);
    expect(artifact.dist?.signatures).toEqual([{ keyid: "SHA256:key", sig: "MEUC…" }]);
    expect(artifact.hints).toEqual({
      gitHead: "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a",
      repository: "git+https://github.com/sigstore/sigstore-js.git",
    });
    expect(artifact.attestations?.attestations).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      `${REGISTRY}sigstore/5.0.0`,
      `${REGISTRY}sigstore/-/sigstore-5.0.0.tgz`,
      `${REGISTRY}-/npm/v1/attestations/sigstore@5.0.0`,
    ]);
    for (const call of calls) {
      expect(call.headers.authorization).toBe("Bearer tok");
    }
  });

  it("fetches a legacy package using its published case", async () => {
    const manifest = manifestFor({
      name: "JSONStream",
      version: "1.3.5",
      dist: {
        integrity: `sha512-${digests.sha512Base64}`,
        tarball: `${REGISTRY}JSONStream/-/JSONStream-1.3.5.tgz`,
      },
    });
    const { fetch, calls } = registryFetch({
      [`${REGISTRY}JSONStream/1.3.5`]: json(manifest),
      [`${REGISTRY}JSONStream/-/JSONStream-1.3.5.tgz`]: bytes(tarball),
    });
    const artifact = await fetchPublished("JSONStream@1.3.5", {
      fetch,
      env: {},
      npmrcPaths: [],
    });
    expect(artifact.name).toBe("JSONStream");
    expect(artifact.purl).toBe("pkg:npm/JSONStream@1.3.5");
    expect(calls.map((call) => call.url)).toEqual([
      `${REGISTRY}JSONStream/1.3.5`,
      `${REGISTRY}JSONStream/-/JSONStream-1.3.5.tgz`,
    ]);
  });

  it("encodes the slash of scoped names in the version path", async () => {
    const manifest = { ...manifestFor(), name: "@sigstore/verify", version: "4.1.2" };
    const { fetch, calls } = registryFetch({
      [`${REGISTRY}@sigstore%2fverify/4.1.2`]: json(manifest),
      [`${REGISTRY}sigstore/-/sigstore-5.0.0.tgz`]: bytes(tarball),
      [`${REGISTRY}-/npm/v1/attestations/sigstore@5.0.0`]: json(sigstoreAttestations()),
    });
    const artifact = await fetchPublished("@sigstore/verify@4.1.2", {
      fetch,
      env: {},
      npmrcPaths: [],
    });
    expect(artifact.purl).toBe("pkg:npm/%40sigstore/verify@4.1.2");
    expect(calls[0]?.url).toBe(`${REGISTRY}@sigstore%2fverify/4.1.2`);
  });

  it("fetches the tarball and attestations by path on our registry, whatever host the document names", async () => {
    const manifest = manifestFor();
    const dist = manifest.dist as { tarball: string; attestations: { url: string } };
    dist.tarball = "https://evil.example/sigstore/-/sigstore-5.0.0.tgz";
    dist.attestations.url = "https://evil.example/-/npm/v1/attestations/sigstore@5.0.0";
    const { fetch, calls } = registryFetch(routesFor(manifest));
    await fetchPublished("sigstore@5.0.0", { fetch, env: {}, npmrcPaths: [] });
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      "registry.npmjs.org",
      "registry.npmjs.org",
      "registry.npmjs.org",
    ]);
  });

  it("keeps a private registry's base path exactly once", async () => {
    const registry = "https://npm.example.com/npm/";
    const manifest = manifestFor();
    (manifest.dist as { tarball: string }).tarball =
      "https://npm.example.com/npm/sigstore/-/sigstore-5.0.0.tgz";
    const { fetch, calls } = registryFetch(routesFor(manifest, { registry }));
    await fetchPublished("sigstore@5.0.0", { fetch, registry, env: {}, npmrcPaths: [] });
    expect(calls[1]?.url).toBe("https://npm.example.com/npm/sigstore/-/sigstore-5.0.0.tgz");
  });

  it("reports null attestations when the registry has none (404), and skips the request when dist has none", async () => {
    const { fetch } = registryFetch({
      ...routesFor(manifestFor()),
      [`${REGISTRY}-/npm/v1/attestations/sigstore@5.0.0`]: json("", 404),
    });
    expect(
      (await fetchPublished("sigstore@5.0.0", { fetch, env: {}, npmrcPaths: [] })).attestations,
    ).toBeNull();

    const manifest = manifestFor();
    delete (manifest.dist as Record<string, unknown>).attestations;
    const without = registryFetch(routesFor(manifest));
    const artifact = await fetchPublished("sigstore@5.0.0", {
      fetch: without.fetch,
      env: {},
      npmrcPaths: [],
    });
    expect(artifact.attestations).toBeNull();
    expect(without.calls).toHaveLength(2);
  });

  it("fails closed when the tarball does not match the integrity", async () => {
    const { fetch } = registryFetch(
      routesFor(manifestFor(), { tarballData: Buffer.from("different bytes") }),
    );
    await expect(
      fetchPublished("sigstore@5.0.0", { fetch, env: {}, npmrcPaths: [] }),
    ).rejects.toThrow(/does not match its integrity/);
  });

  it("fails closed when the registry provides no sha512 integrity or no tarball URL", async () => {
    const noSha = manifestFor();
    (noSha.dist as Record<string, unknown>).integrity = "sha1-abc";
    await expect(
      fetchPublished("sigstore@5.0.0", {
        fetch: registryFetch(routesFor(noSha)).fetch,
        env: {},
        npmrcPaths: [],
      }),
    ).rejects.toThrow(/no.*sha512 integrity/i);
    const noTarball = manifestFor();
    delete (noTarball.dist as Record<string, unknown>).tarball;
    await expect(
      fetchPublished("sigstore@5.0.0", {
        fetch: registryFetch(routesFor(noTarball)).fetch,
        env: {},
        npmrcPaths: [],
      }),
    ).rejects.toThrow(/no.*tarball URL/i);
  });

  it("rejects a document for a different package or version, and a missing version", async () => {
    await expect(
      fetchPublished("sigstore@5.0.0", {
        fetch: registryFetch(routesFor(manifestFor({ version: "5.0.1" }))).fetch,
        env: {},
        npmrcPaths: [],
      }),
    ).rejects.toThrow(/returned sigstore@5.0.1 when asked for sigstore@5.0.0/);
    const { fetch } = registryFetch({ [`${REGISTRY}sigstore/5.0.0`]: json("", 404) });
    await expect(
      fetchPublished("sigstore@5.0.0", { fetch, env: {}, npmrcPaths: [] }),
    ).rejects.toThrow(
      /sigstore@5.0.0 was not found on https:\/\/registry\.npmjs\.org\/\. If it was just published, retry in a minute or run the check after the publish job \(needs: publish\)\. A staged version that is not approved yet is checked with --stage <id>\./,
    );
  });

  it("surfaces registry failures as ToolError", async () => {
    const { fetch } = registryFetch({
      [`${REGISTRY}sigstore/5.0.0`]: () => new Response("", { status: 503 }),
    });
    await expect(
      fetchPublished("sigstore@5.0.0", { fetch, env: {}, npmrcPaths: [] }),
    ).rejects.toThrow(ToolError);
  });
});

describe("registryRelativePath", () => {
  it("keeps the path for a root registry and strips a shared base path", () => {
    expect(registryRelativePath(REGISTRY, "https://cdn.example/x/-/x-1.0.0.tgz", "tarball")).toBe(
      "/x/-/x-1.0.0.tgz",
    );
    expect(
      registryRelativePath(
        "https://npm.example.com/npm/",
        "https://npm.example.com/npm/x/-/x-1.0.0.tgz",
        "tarball",
      ),
    ).toBe("/x/-/x-1.0.0.tgz");
    expect(
      registryRelativePath(
        "https://npm.example.com/npm/",
        "https://other.example/x/-/x-1.0.0.tgz",
        "tarball",
      ),
    ).toBe("/x/-/x-1.0.0.tgz");
    expect(() => registryRelativePath(REGISTRY, "not a url", "tarball")).toThrow(
      /invalid tarball URL/,
    );
  });
});

describe("readDist", () => {
  it("keeps only well-typed fields", () => {
    expect(
      readDist({
        integrity: 5,
        shasum: "abc",
        signatures: [{ keyid: "k" }, { keyid: "k", sig: "s" }],
      }),
    ).toEqual({
      integrity: undefined,
      shasum: "abc",
      tarball: undefined,
      signatures: [{ keyid: "k", sig: "s" }],
    });
    expect(readDist(null)).toEqual({});
  });
});

describe("readAttestations", () => {
  it("rejects the whole response when one entry is malformed", () => {
    expect(
      readAttestations({ attestations: [{ predicateType: "x", bundle: "not an object" }] }),
    ).toBeNull();
    expect(readAttestations({ attestations: "nope" })).toBeNull();
    expect(readAttestations({ attestations: [] })).toEqual({ attestations: [] });
  });
});
