import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import { normalizeRegistry, registryBytes, registryJson, registryUrl } from "./client.js";

type FetchMock = ReturnType<
  typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>
>;

function fetchReturning(response: Response | (() => Promise<Response>)): FetchMock {
  return vi.fn(typeof response === "function" ? response : async () => response);
}

function asFetch(mock: FetchMock): typeof fetch {
  return mock as unknown as typeof fetch;
}

describe("normalizeRegistry", () => {
  it("defaults to the public registry with a trailing slash", () => {
    expect(normalizeRegistry()).toBe("https://registry.npmjs.org/");
    expect(normalizeRegistry("https://npm.example.com/npm")).toBe("https://npm.example.com/npm/");
  });

  it("drops query and hash", () => {
    expect(normalizeRegistry("https://npm.example.com/?x=1#y")).toBe("https://npm.example.com/");
  });

  it.each(["ftp://npm.example.com", "not a url", "file:///etc/passwd"])("rejects %j", (input) => {
    expect(() => normalizeRegistry(input)).toThrow(ToolError);
  });
});

describe("registryUrl", () => {
  it("keeps a registry base path, unlike new URL()", () => {
    expect(registryUrl("https://npm.example.com/npm", "/-/stage/x")).toBe(
      "https://npm.example.com/npm/-/stage/x",
    );
    expect(registryUrl(undefined, "/-/npm/v1/keys")).toBe(
      "https://registry.npmjs.org/-/npm/v1/keys",
    );
  });

  it("refuses paths that are not registry-relative", () => {
    expect(() => registryUrl(undefined, "https://evil.example/x")).toThrow(ToolError);
  });
});

describe("registryJson", () => {
  it("sends the token and accept header and parses JSON", async () => {
    const mock = fetchReturning(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(
      registryJson("/-/stage/abc", { token: "tok", fetch: asFetch(mock) }),
    ).resolves.toEqual({ ok: 1 });
    const [url, init] = mock.mock.calls[0] ?? [];
    expect(url).toBe("https://registry.npmjs.org/-/stage/abc");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer tok",
      accept: "application/json",
      "user-agent": "releaseproof",
    });
  });

  it("sends no authorization header without a token", async () => {
    const mock = fetchReturning(new Response("{}", { status: 200 }));
    await registryJson("/x", { fetch: asFetch(mock) });
    const [, init] = mock.mock.calls[0] ?? [];
    expect(init?.headers).not.toHaveProperty("authorization");
  });

  it("returns null on 404", async () => {
    const mock = fetchReturning(new Response("nope", { status: 404 }));
    await expect(registryJson("/x", { fetch: asFetch(mock) })).resolves.toBeNull();
  });

  it("throws ToolError with a token hint on 401/403", async () => {
    const mock = fetchReturning(new Response("", { status: 403 }));
    await expect(registryJson("/x", { fetch: asFetch(mock) })).rejects.toThrow(
      /HTTP 403 for \/x \(check your npm token/,
    );
  });

  it("throws ToolError on invalid JSON", async () => {
    const mock = fetchReturning(new Response("<html>", { status: 200 }));
    await expect(registryJson("/x", { fetch: asFetch(mock) })).rejects.toThrow(/invalid JSON/);
  });

  it("wraps network errors in ToolError", async () => {
    const mock = fetchReturning(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(registryJson("/x", { fetch: asFetch(mock) })).rejects.toThrow(
      /Request to https:\/\/registry.npmjs.org\/x failed: fetch failed/,
    );
  });
});

describe("registryBytes", () => {
  it("returns the body as a Buffer", async () => {
    const mock = fetchReturning(new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    const bytes = await registryBytes("/-/stage/abc/tarball", { fetch: asFetch(mock) });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("treats 404 as an error, not as empty bytes", async () => {
    const mock = fetchReturning(new Response("", { status: 404 }));
    await expect(registryBytes("/x", { fetch: asFetch(mock) })).rejects.toThrow(ToolError);
  });
});

describe.each(["JSON", "tarball"] as const)("%s registry token transport", (kind) => {
  const load = (registry: string, token: string | undefined, mock: FetchMock) => {
    const options = { registry, token, fetch: asFetch(mock) };
    return kind === "JSON" ? registryJson("/x", options) : registryBytes("/x", options);
  };

  it.each([
    "http://npm.example.com/",
    "http://localhost.evil.example/",
    "http://127.0.0.1.evil.example/",
    "http://[2001:db8::1]/",
    "http://user:npm_test_secret@npm.example.com/",
  ])(
    "refuses authenticated HTTP to %s before fetch without exposing the token",
    async (registry) => {
      const mock = fetchReturning(new Response("{}"));
      const error = await load(registry, "npm_test_secret", mock).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ToolError);
      expect(error).toMatchObject({ message: expect.stringContaining("https://") });
      expect((error as Error).message).not.toContain("npm_test_secret");
      expect(mock).not.toHaveBeenCalled();
    },
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "preserves authenticated HTTP to loopback %s",
    async (host) => {
      const mock = fetchReturning(new Response("{}"));
      await load(`http://${host}:4873/`, "local_token", mock);
      expect(mock).toHaveBeenCalledExactlyOnceWith(
        `http://${host}:4873/x`,
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer local_token" }),
        }),
      );
    },
  );

  it("preserves unauthenticated remote HTTP", async () => {
    const mock = fetchReturning(new Response("{}"));
    await load("http://npm.example.com/", undefined, mock);
    expect(mock).toHaveBeenCalledExactlyOnceWith(
      "http://npm.example.com/x",
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      }),
    );
  });

  it("preserves authenticated HTTPS", async () => {
    const mock = fetchReturning(new Response("{}"));
    await load("https://npm.example.com/", "https_token", mock);
    expect(mock).toHaveBeenCalledExactlyOnceWith(
      "https://npm.example.com/x",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer https_token" }),
      }),
    );
  });
});
