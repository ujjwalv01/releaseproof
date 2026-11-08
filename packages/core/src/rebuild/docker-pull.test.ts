import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import { createDockerClient } from "./docker.js";
import { rebuildPackage } from "./run.js";
import { INSPECTION_MARKER } from "./scripts.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("execa", () => ({ execa: run }));

afterEach(() => run.mockReset());

const image = "node:12-bookworm";
const hint = `image ${JSON.stringify(image)} does not exist; pick a supported Node major with --node, or name an image with --image`;

describe("Docker image pulls", () => {
  it("pulls an available image with the existing arguments and timeout", async () => {
    run.mockResolvedValue({ failed: false, stdout: "sha256:abc" });
    await expect(
      createDockerClient({ binary: "fake-docker" }).pull(image),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledExactlyOnceWith("fake-docker", ["pull", "--quiet", image], {
      reject: false,
      timeout: 15 * 60_000,
      stdin: "ignore",
    });
  });

  it.each([
    "Error response from daemon: manifest unknown",
    `Error response from daemon: manifest for ${image} not found: manifest unknown: manifest unknown`,
    `Error response from daemon: manifest for ${image} not found`,
    `Error response from daemon: failed to resolve reference "docker.io/library/${image}": docker.io/library/${image}: not found`,
    `Error response from daemon: image ${image} not found`,
    `Error response from daemon: failed to resolve reference "${image}": "${image}": not found`,
  ])("adds an actionable image hint for %s", async (stderr) => {
    run.mockResolvedValue({ failed: true, stderr });
    const error = await createDockerClient()
      .pull(image)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      message: hint,
      cause: { message: `docker pull --quiet failed: ${stderr}` },
    });
  });

  it.each([
    "dial tcp: lookup registry-1.docker.io: no such host",
    "net/http: TLS handshake timeout",
    "unauthorized: authentication required",
    `pull access denied for ${image}, repository does not exist or may require 'docker login'`,
    "Error response from daemon: received unexpected HTTP status: 404 Not Found",
    `proxy for ${image}: request failed: 404 Not Found`,
    `proxy for ${image} not found in network configuration`,
    "no matching manifest for linux/arm64/v8 in the manifest list entries",
    "spawn docker ENOENT",
  ])("preserves unrelated failure detail for %s", async (stderr) => {
    run.mockResolvedValue({ failed: true, stderr });
    await expect(createDockerClient().pull(image)).rejects.toMatchObject({
      message: `docker pull --quiet failed: ${stderr}`,
    });
  });

  it("recognizes an explicit registry image without treating its dots as wildcards", async () => {
    const image = "ghcr.io/acme/node:12-bookworm";
    const stderr = `Error response from daemon: ${image}: not found`;
    run.mockResolvedValueOnce({ failed: true, stderr });
    await expect(createDockerClient().pull(image)).rejects.toMatchObject({
      message: `image ${JSON.stringify(image)} does not exist; pick a supported Node major with --node, or name an image with --image`,
    });
    const otherImage = stderr.replace("ghcr.io", "ghcrXio");
    run.mockResolvedValueOnce({ failed: true, stderr: otherImage });
    await expect(createDockerClient().pull(image)).rejects.toMatchObject({
      message: `docker pull --quiet failed: ${otherImage}`,
    });
  });

  it("preserves an unrelated thrown runner error by identity", async () => {
    const error = new Error("runner could not start");
    run.mockRejectedValue(error);
    await expect(createDockerClient().pull(image)).rejects.toBe(error);
  });

  it.each(["base", "planned"])(
    "propagates a missing %s image from the rebuild and removes its volume",
    async (failedPull) => {
      const commit = "a".repeat(40);
      const inspection = {
        commit,
        lockfiles: [],
        nodeVersionFiles: {},
        hasYarnrcYml: false,
        hasPnpmWorkspace: false,
        hasLernaJson: false,
        hasSubmodules: false,
        packages: [{ dir: ".", name: "tiny", version: "1.0.0", scripts: {} }],
      };
      const missing = failedPull === "base" ? "node:22-bookworm" : image;
      run.mockImplementation(async (_binary: string, args: string[]) => {
        if (args[0] === "pull" && args[2] === missing) {
          return { failed: true, stderr: `manifest for ${missing} not found` };
        }
        const stdout =
          args[0] === "version"
            ? "29.8.2"
            : args.includes("releaseproof-missing-clone")
              ? `${INSPECTION_MARKER}\n${JSON.stringify(inspection)}`
              : "";
        return { failed: false, stdout, exitCode: 0, stderr: "", timedOut: false };
      });
      await expect(
        rebuildPackage(
          { repository: "https://github.com/o/r", commit, verified: true },
          { name: "tiny", version: "1.0.0" },
          { volumeId: "missing", overrides: { nodeMajor: 12 } },
        ),
      ).rejects.toThrow(
        `image ${JSON.stringify(missing)} does not exist; pick a supported Node major with --node, or name an image with --image`,
      );
      expect(run).toHaveBeenLastCalledWith(
        "docker",
        ["volume", "rm", "--force", "releaseproof-missing"],
        expect.any(Object),
      );
      const calls: string[][] = run.mock.calls.map((call) => call[1]);
      expect(calls.some((args) => args.includes("releaseproof-missing-install"))).toBe(false);
    },
  );
});
