import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import { createDockerClient } from "./docker.js";

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

describe("serverVersion", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  const missing =
    "docker was not found on PATH: install Docker (https://docs.docker.com/get-docker/), or open a new terminal if you just installed it";
  const stopped =
    "Docker is installed but not running: start Docker Desktop (or the docker service) and try again";
  const fallback = "Docker is not available (is Docker Desktop running?)";

  it.each([
    {
      name: "missing command on PATH",
      detail:
        "Command failed with ENOENT: docker version --format {{.Server.Version}}\nspawn docker ENOENT",
      advice: missing,
      field: "shortMessage",
    },
    {
      name: "Windows missing command without an ENOENT code",
      detail:
        "'docker' is not recognized as an internal or external command,\r\noperable program or batch file.",
      advice: missing,
      field: "stderr",
    },
    {
      name: "Linux daemon not running",
      detail:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      advice: stopped,
      field: "stderr",
    },
    {
      name: "Windows Docker Desktop engine unavailable",
      detail: "open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
      advice: stopped,
      field: "stderr",
    },
    {
      name: "connection failure regardless of capitalization",
      detail: "Error during connect: this error may indicate that the docker daemon is not running",
      advice: stopped,
      field: "stderr",
    },
    {
      name: "permission denied is not assumed to be a stopped daemon",
      detail: "permission denied while trying to connect to the Docker daemon socket",
      advice: fallback,
      field: "stderr",
    },
    {
      name: "unrelated connection failure keeps the fallback",
      detail: "Cannot connect to the Docker registry",
      advice: fallback,
      field: "stderr",
    },
    {
      name: "unknown failure keeps the fallback",
      detail: "unexpected version response",
      advice: fallback,
      field: "shortMessage",
    },
    {
      name: "code-like text is not treated as ENOENT",
      detail: "unexpected error code XENOENT",
      advice: fallback,
      field: "shortMessage",
    },
  ])("explains $name and retains the raw detail", async ({ detail, advice, field }) => {
    execaMock.mockResolvedValue({ failed: true, [field]: detail });
    const error = await createDockerClient()
      .serverVersion()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      message: `${advice}: docker version --format failed: ${detail}`,
      cause: expect.objectContaining({ message: `docker version --format failed: ${detail}` }),
    });
    expect(execaMock).toHaveBeenCalledExactlyOnceWith(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { reject: false, timeout: 30_000, stdin: "ignore" },
    );
  });

  it("preserves a runner rejection and its cause", async () => {
    const cause = new Error("unexpected runner rejection");
    execaMock.mockRejectedValue(cause);
    await expect(createDockerClient().serverVersion()).rejects.toMatchObject({
      message: `${fallback}: ${cause.message}`,
      cause,
    });
  });

  it("returns the trimmed server version using the configured binary", async () => {
    execaMock.mockResolvedValue({ failed: false, stdout: " 29.0.1\r\n" });
    await expect(createDockerClient({ binary: "custom-docker" }).serverVersion()).resolves.toBe(
      "29.0.1",
    );
    expect(execaMock).toHaveBeenCalledExactlyOnceWith(
      "custom-docker",
      ["version", "--format", "{{.Server.Version}}"],
      { reject: false, timeout: 30_000, stdin: "ignore" },
    );
  });
});
