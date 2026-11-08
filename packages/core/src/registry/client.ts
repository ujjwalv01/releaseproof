import { errorMessage, ToolError } from "../errors.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

export interface RegistryOptions {
  /** Registry base URL. Defaults to the public npm registry. */
  registry?: string | undefined;
  /** Bearer token for the registry. When absent, it is looked up in `env` and `npmrcPaths`. */
  token?: string | undefined;
  /** Environment to read NPM_TOKEN / NODE_AUTH_TOKEN from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv | undefined;
  /** .npmrc files to consult for a token. Defaults to the project and user files. */
  npmrcPaths?: string[] | undefined;
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch | undefined;
  /** Request timeout in milliseconds. */
  timeoutMs?: number | undefined;
}

/** Validates the registry URL and returns it with a trailing slash and no query/hash. */
export function normalizeRegistry(registry: string = DEFAULT_REGISTRY): string {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    throw new ToolError(`Invalid registry URL "${registry}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ToolError(`Registry URL must use http(s): "${registry}"`);
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Joins a registry-relative path such as `/-/stage/<id>` onto the registry base. Unlike
 * `new URL(path, base)` this keeps a base path (`https://host/npm/`), like npm does.
 */
export function registryUrl(registry: string | undefined, path: string): string {
  if (!path.startsWith("/")) {
    throw new ToolError(`Registry path must start with "/": "${path}"`);
  }
  return normalizeRegistry(registry) + path.slice(1);
}

async function request(path: string, accept: string, options: RegistryOptions): Promise<Response> {
  const url = registryUrl(options.registry, path);
  const headers: Record<string, string> = { accept, "user-agent": "releaseproof" };
  if (options.token) {
    const target = new URL(url);
    if (
      target.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
    ) {
      throw new ToolError(
        "Refusing to send a registry token over unencrypted HTTP to a non-loopback host; use an https:// registry URL.",
      );
    }
    headers.authorization = `Bearer ${options.token}`;
  }
  const doFetch = options.fetch ?? fetch;
  try {
    // fetch drops the Authorization header on cross-origin redirects, so a registry that
    // bounces us to a CDN never receives the token there.
    return await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    throw new ToolError(`Request to ${url} failed: ${errorMessage(error)}`, { cause: error });
  }
}

function describeStatus(response: Response, path: string): string {
  const hint =
    response.status === 401 || response.status === 403
      ? " (check your npm token and its permissions)"
      : "";
  return `Registry returned HTTP ${response.status} for ${path}${hint}`;
}

/** GETs JSON from the registry. Returns null on 404; throws ToolError on other failures. */
export async function registryJson<T>(
  path: string,
  options: RegistryOptions = {},
): Promise<T | null> {
  const response = await request(path, "application/json", options);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new ToolError(describeStatus(response, path));
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ToolError(`Registry returned invalid JSON for ${path}`, { cause: error });
  }
}

/** GETs raw bytes (a tarball) from the registry. Throws ToolError on any non-2xx status. */
export async function registryBytes(path: string, options: RegistryOptions = {}): Promise<Buffer> {
  const response = await request(path, "application/octet-stream", {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (!response.ok) {
    throw new ToolError(describeStatus(response, path));
  }
  return Buffer.from(await response.arrayBuffer());
}
