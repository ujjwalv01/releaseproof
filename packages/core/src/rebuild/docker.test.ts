import { describe, expect, it } from "vitest";
import { ToolError } from "../errors.js";
import { type ContainerSpec, dockerRunArgs, parseMemoryLimit } from "./docker.js";

describe("parseMemoryLimit", () => {
  it.each([
    ["4g", "4g"],
    ["6144m", "6144m"],
    ["512", "512"],
    ["512K", "512k"],
    [" 6G ", "6g"],
    ["0", "0"],
    ["", undefined],
    ["   ", undefined],
    [undefined, undefined],
  ])("normalizes %j", (memory, expected) => {
    expect(parseMemoryLimit(memory)).toBe(expected);
  });

  it.each(["4gb", "four", "-1g", "1.5g", "4g --privileged", "4g; echo unsafe", "4g\0", "4\n2g"])(
    "rejects %j as a tool error",
    (memory) => {
      expect(() => parseMemoryLimit(memory)).toThrow(
        new ToolError(`--memory must be a Docker size such as 4g or 6144m, got "${memory}"`),
      );
    },
  );
});

const spec: ContainerSpec = {
  name: "releaseproof-abc-build",
  image: "node:22-bookworm",
  volume: "releaseproof-abc",
  network: "none",
  env: { RP_COMMIT: "deadbeef", RP_REPOSITORY: "https://github.com/o/r" },
  argv: ["bash", "-c", "echo hi"],
  timeoutMs: 1000,
  memory: "4g",
  pidsLimit: 4096,
  user: "1000:1000",
  workdir: "/work",
};

describe("dockerRunArgs", () => {
  it("applies every hardening flag and mounts only the named volume", () => {
    const args = dockerRunArgs(spec);
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    for (const pair of [
      ["--user", "1000:1000"],
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
      ["--pids-limit", "4096"],
      ["--memory", "4g"],
      ["--network", "none"],
      ["--workdir", "/work"],
      ["--volume", "releaseproof-abc:/work"],
      ["-e", "RP_COMMIT=deadbeef"],
      ["-e", "RP_REPOSITORY=https://github.com/o/r"],
    ]) {
      const found = args.some((arg, i) => arg === pair[0] && args[i + 1] === pair[1]);
      expect(found, pair.join(" ")).toBe(true);
    }
    // No bind mounts, no privileged flag, no host network.
    expect(args.filter((a) => a === "--volume" || a === "-v")).toHaveLength(1);
    expect(args.join(" ")).not.toMatch(/--privileged|host\.docker|--network host|:\/work:rw/);
    // The image comes right before the command.
    expect(args.slice(-4)).toEqual(["node:22-bookworm", "bash", "-c", "echo hi"]);
  });

  it("mounts the volume read-only when asked", () => {
    expect(dockerRunArgs({ ...spec, volumeReadOnly: true })).toContain("releaseproof-abc:/work:ro");
  });

  it("adds capabilities back only when a stage asks, after dropping all", () => {
    expect(dockerRunArgs(spec)).not.toContain("--cap-add");
    const args = dockerRunArgs({ ...spec, capAdd: ["CHOWN"] });
    const drop = args.indexOf("--cap-drop");
    expect(args.slice(drop, drop + 4)).toEqual(["--cap-drop", "ALL", "--cap-add", "CHOWN"]);
  });
});
