import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { type CheckCommandOptions, runCheckCommand } from "./commands/check.js";

export function createProgram(): Command {
  const program = new Command()
    .name("releaseproof")
    .description("Verify that an npm release matches its source before you approve it.")
    .version(pkg.version, "-v, --version");

  program
    .command("check")
    .description("Rebuild a published or staged version from its source and compare the two")
    .argument("[package]", "<name>@<version>, for example sigstore@5.0.0")
    .option(
      "--stage <id>",
      "check a staged version by its stage id instead (needs a registry token)",
    )
    .option("--registry <url>", "registry base URL (default: https://registry.npmjs.org/)")
    .option("--token <token>", "registry token (default: NPM_TOKEN, NODE_AUTH_TOKEN or .npmrc)")
    .option(
      "--repo <url>",
      "repository you expect; with --commit, the source to rebuild from when there is no provenance",
    )
    .option("--commit <sha>", "full commit SHA to rebuild from when there is no provenance")
    .option("--image <image>", "Docker image for the build (default: node:<major>-bookworm)")
    .option("--node <major>", "Node.js major to build with (default: from the release workflow)")
    .option("--build-command <command>", "shell command to build with instead of the detected one")
    .option("--memory <size>", "Docker memory limit for the build containers (default: 4g)")
    .option("--offline", "use the cached Sigstore trust root without refreshing it")
    .option(
      "--no-rekor",
      "skip looking up a staged version's provenance in the Rekor transparency log (the lookup sends Rekor the tarball's SHA-512)",
    )
    .option("--keep-volume", "keep the Docker volume after the run, for debugging")
    .option("--json", "print the full report as JSON")
    .option("--quiet", "no progress output on stderr")
    .action(async (spec: string | undefined, options: CheckCommandOptions) => {
      process.exitCode = await runCheckCommand(spec, options, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    });

  return program;
}
