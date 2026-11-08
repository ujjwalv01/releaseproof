import { execa } from "execa";
import { errorMessage, ToolError } from "../errors.js";

export interface ContainerSpec {
  name: string;
  image: string;
  /** Docker volume mounted at /work. */
  volume: string;
  volumeReadOnly?: boolean | undefined;
  network: "bridge" | "none";
  env: Record<string, string>;
  argv: string[];
  timeoutMs: number;
  /** Docker memory limit such as "4g". */
  memory: string;
  pidsLimit: number;
  /** "1000:1000" for every stage except the volume initialisation. */
  user: string;
  /** Capabilities added back after `--cap-drop ALL`. Only the init stage needs CHOWN. */
  capAdd?: string[] | undefined;
  workdir: string;
}

export interface ContainerResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** What the rebuild needs from Docker. Injectable so the orchestration is testable. */
export interface DockerClient {
  serverVersion(): Promise<string>;
  pull(image: string): Promise<void>;
  imageDigest(image: string): Promise<string | undefined>;
  createVolume(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  run(spec: ContainerSpec): Promise<ContainerResult>;
}

/** Shared CLI/Action validation; an empty input leaves the rebuild default in effect. */
export function parseMemoryLimit(
  value: string | undefined,
  inputName = "--memory",
): string | undefined {
  const memory = value?.trim().toLowerCase();
  if (!memory) return undefined;
  if (!/^\d+[kmg]?$/.test(memory)) {
    throw new ToolError(`${inputName} must be a Docker size such as 4g or 6144m, got "${memory}"`);
  }
  return memory;
}

/**
 * The `docker run` argument list for a stage. Pure, so the hardening flags can be asserted
 * in tests: no capabilities, no privilege escalation, pid and memory limits, no host mounts
 * (only the named volume), an unprivileged user and an explicit network mode.
 */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  const envArgs = Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const capArgs = (spec.capAdd ?? []).flatMap((cap) => ["--cap-add", cap]);
  return [
    "run",
    "--rm",
    "--name",
    spec.name,
    "--user",
    spec.user,
    "--cap-drop",
    "ALL",
    ...capArgs,
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(spec.pidsLimit),
    "--memory",
    spec.memory,
    "--network",
    spec.network,
    "--workdir",
    spec.workdir,
    "--volume",
    `${spec.volume}:/work${spec.volumeReadOnly ? ":ro" : ""}`,
    ...envArgs,
    spec.image,
    ...spec.argv,
  ];
}

export interface ExecaDockerOptions {
  /** Path to the docker CLI. Defaults to "docker" on PATH. */
  binary?: string | undefined;
}

/** DockerClient backed by the docker CLI through execa (no shell involved). */
export function createDockerClient(options: ExecaDockerOptions = {}): DockerClient {
  const binary = options.binary ?? "docker";

  async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
    const result = await execa(binary, args, {
      reject: false,
      timeout: timeoutMs,
      stdin: "ignore",
    });
    if (result.failed) {
      const detail = result.stderr?.trim() || result.shortMessage || errorMessage(result.cause);
      throw new ToolError(`docker ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
    return result.stdout;
  }

  return {
    async serverVersion() {
      try {
        return (await docker(["version", "--format", "{{.Server.Version}}"], 30_000)).trim();
      } catch (error) {
        const detail = errorMessage(error);
        let advice = "Docker is not available (is Docker Desktop running?)";
        if (/\bENOENT\b|not recognized as an internal or external command/i.test(detail)) {
          advice =
            "docker was not found on PATH: install Docker (https://docs.docker.com/get-docker/), or open a new terminal if you just installed it";
        } else if (
          /cannot connect to the docker daemon|dockerDesktopLinuxEngine|error during connect/i.test(
            detail,
          )
        ) {
          advice =
            "Docker is installed but not running: start Docker Desktop (or the docker service) and try again";
        }
        throw new ToolError(`${advice}: ${detail}`, { cause: error });
      }
    },
    async pull(image) {
      try {
        await docker(["pull", "--quiet", image], 15 * 60_000);
      } catch (error) {
        const detail = errorMessage(error);
        const escapedImage = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Do not mistake a proxy's HTTP 404 or a platform mismatch for a missing image.
        const imageNotFound = new RegExp(
          String.raw`(?:^|:\s+)(?:image\s+)?["']?(?:[\w.:-]+/)*${escapedImage}["']?:?\s+not found(?:$|:)`,
          "im",
        );
        if (
          error instanceof ToolError &&
          (/\bmanifest (?:unknown\b|for \S+ not found(?:$|:))/im.test(detail) ||
            imageNotFound.test(detail))
        ) {
          throw new ToolError(
            `image ${JSON.stringify(image)} does not exist; pick a supported Node major with --node, or name an image with --image`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    async imageDigest(image) {
      try {
        const digest = await docker([
          "image",
          "inspect",
          "--format",
          "{{index .RepoDigests 0}}",
          image,
        ]);
        return digest.trim() || undefined;
      } catch {
        return undefined;
      }
    },
    async createVolume(name) {
      await docker(["volume", "create", name]);
    },
    async removeVolume(name) {
      await docker(["volume", "rm", "--force", name]);
    },
    async run(spec) {
      const started = Date.now();
      const result = await execa(binary, dockerRunArgs(spec), {
        reject: false,
        timeout: spec.timeoutMs,
        stdin: "ignore",
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.timedOut) {
        // execa killed the CLI; the container keeps running until we remove it.
        await execa(binary, ["rm", "--force", spec.name], {
          reject: false,
          timeout: 60_000,
          stdin: "ignore",
        });
      }
      return {
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
        stdout: Buffer.from(result.stdout ?? ""),
        stderr: Buffer.from(result.stderr ?? "").toString("utf8"),
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
      };
    },
  };
}
