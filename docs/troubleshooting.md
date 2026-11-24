# Troubleshooting failed rebuilds

When a rebuild cannot complete, the verdict is `COULD NOT VERIFY` (exit code `2`) and the
`Rebuild` line in the report gives one short failure message:

```text
Rebuild      FAILED (4m 12s)  install stage exited with code 1
```

> **Principle:** None of these failure messages means the package is malicious, and none of
> them means the package is safe. `COULD NOT VERIFY` means verification did not finish; any
> findings reported below the summary still require attention. See
> [Why is "could not verify" never "safe"?](faq.md#why-is-could-not-verify-never-safe).

---

## `<stage> stage timed out` or `<stage> stage exited with code <N>`

**Messages as printed:**

- `init stage timed out` / `init stage exited with code <N>`
- `clone stage timed out` / `clone stage exited with code <N>`
- `install stage timed out` / `install stage exited with code <N>`
- `build stage timed out` / `build stage exited with code <N>`
- `export stage timed out` / `export stage exited with code <N>`

**What it means:** One of the Docker container stages (`init`, `clone`, `install`, `build`, or
`export`) exceeded its timeout (10 minutes for `clone`, 20 minutes for `install`, 30 minutes
for `build`) or returned a non-zero exit status. When the stage produced output, the text
report prints up to 20 non-blank lines under `last output of the <stage> stage:`, and the JSON
report (`--json` or `--report`) stores the stage tail in `rebuild.stages[].output`.

**What to try:**

- **`init` stage:** Prepares `/work` inside the Docker volume. Verify that the local Docker
  daemon has free disk space and supports `--cap-add CHOWN`.
- **`clone` stage:** Fetches the repository and commit from GitHub. Check that the repository
  URL and 40-character commit SHA exist on GitHub (`--repo` and `--commit`) and that the host
  network can reach `github.com`.
- **`install` stage:** Downloads dependencies from the lockfile with `--ignore-scripts`.
  - If the package manager or lockfile requires a specific Node.js version, pass `--node <major>`
    (for example `--node 20` or `--node 24`).
  - If a native toolchain or system library is required, pass a compatible image with
    `--image <image>`.
- **`build` stage:** Runs dependency rebuild scripts, the package's build script, and packs the
  tarball completely offline (`--network none`).
  - If the wrong Node.js major was detected, override it with `--node <major>`.
  - If the repository needs a specific build command (for example a monorepo filter or custom
    flag), pass `--build-command "<cmd>"`.
  - If the compiler or bundler ran out of memory (often exit code `137` / `SIGKILL`), raise the
    container limit with `--memory 8g` (default is `4g`).
  - Pass `--keep-volume` to inspect the container volume after a failure.
- **`export` stage:** Reads `/work/out/package.tgz` from the read-only volume. Check Docker disk
  space and the preceding `build` stage output.

---

## `could not read the repository inspection: <detail>`

**Message as printed:** `could not read the repository inspection: …`

**What it means:** After `git checkout` in the `clone` stage, releaseproof runs an in-container
inspection script that lists `package.json` files, lockfiles, and Node version files. This error
appears when the inspection output is missing or malformed.

**What to try:** Re-run with `--json` to inspect `rebuild.stages` for the `clone` stage output,
or verify that the base image (`node:22-bookworm`) can run Node.js cleanly in your Docker
environment.

---

## `checked out <actual> but expected <expected>`

**Message as printed:** `checked out <commit> but expected <commit>`

**What it means:** The `HEAD` commit inside the cloned repository did not match the 40-character
commit SHA requested by provenance or `--commit`.

**What to try:** Ensure `--commit` is a full 40-character hexadecimal Git commit SHA rather than
an abbreviated SHA, tag name, or branch ref.

---

## `package <name> was not found in the repository at this commit`

**Message as printed:** `package <name> was not found in the repository at this commit`

**What it means:** None of the `package.json` files tracked in the repository has
`"name": "<name>"` at the checked-out commit. Every tracked `package.json` is read, at any
depth, except those inside `node_modules`. Common causes include:

- Passing the wrong `--repo` or an older/newer `--commit` before the package existed.
- A package that was renamed or generated dynamically during release.
- A `package.json` that is not valid JSON at that commit; the inspection skips such files.

**What to try:** Check the repository tree at that commit on GitHub to confirm where the
package's `package.json` lives and verify `--repo` and `--commit`.

---

## `several package.json files are named <name> (<dirs>) and none has version <version>`

**Message as printed:** `several package.json files are named <name> (<dirs>) and none has version <version>`

**What it means:** Multiple `package.json` files in the repository declare the same `"name"`,
and none of them carries the target `"version"` being checked, so the planner cannot tell which
directory to build and pack.

**What to try:** Check whether the commit matches the published release version, or inspect the
listed directories in the repository at that commit.

---

## `<name> at <dir> is marked private`

**Message as printed:** `<name> at <dir> is marked private`

**What it means:** The matched `package.json` has `"private": true`, which npm refuses to pack
or publish directly. Some projects strip `"private": true` or generate a separate manifest in a
custom release script.

**What to try:** Verify that `--commit` points to the exact release commit, or check whether the
project publishes from a generated subdirectory.

---

## `package manager "<field>" must name an exact version such as <example>`

**Message as printed:** `package manager "<field>" must name an exact version such as npm@10.9.2`

**What it means:** The `packageManager` field in `package.json` names `npm`, `pnpm`, or `yarn`
without a valid version (for example a range or tag instead of `pnpm@10.9.0`), which Corepack
cannot pin deterministically.

**What to try:** Check the `packageManager` field in the repository's `package.json` at that
commit.

---

## `package manager "<field>" is not supported (only npm, pnpm and yarn are)`

**Message as printed:** `package manager "<field>" is not supported (only npm, pnpm and yarn are)`

**What it means:** The `packageManager` field in `package.json` specifies a tool other than
`npm`, `pnpm`, or `yarn`.

**What to try:** Currently only `npm`, `pnpm`, and `yarn` (Classic and Berry) are supported by
the rebuild planner. See
[Which package managers and repository layouts are supported today?](faq.md#which-package-managers-and-repository-layouts-are-supported-today).

---

## `bun lockfiles are not supported yet`

**Message as printed:** `bun lockfiles are not supported yet`

**What it means:** The repository has a `bun.lock` or `bun.lockb` lockfile and no `packageManager`
field naming `npm`, `pnpm`, or `yarn`.

**What to try:** Bun rebuild support is tracked in the issue tracker; packages locked with Bun
currently end in `COULD NOT VERIFY`.

---

## `publishConfig.directory "<dir>" escapes the package`

**Message as printed:** `publishConfig.directory "<dir>" escapes the package`

**What it means:** `publishConfig.directory` in `package.json` is an absolute path or contains
`..` path segments that leave the package directory. releaseproof refuses to pack outside the
package directory.

**What to try:** Inspect `publishConfig.directory` in the package's `package.json`. If the build
writes a tarball directly or needs custom staging inside the package directory, check the
project's release workflow.

---

## `build stage did not report the tarball digest`

**Message as printed:** `build stage did not report the tarball digest`

**What it means:** The `build` stage finished with exit code `0`, but did not print the SHA-256
digest line for `/work/out/package.tgz` at the end of the script (for example if a custom
command exited early or did not leave a single packed `.tgz` in `/work/out`).

**What to try:** If you passed `--build-command`, ensure the command exits normally instead of
terminating the parent shell early, and inspect `rebuild.stages` in the `--json` output.

---

## `exported tarball digest <actual> does not match the build stage's <expected>`

**Message as printed:** `exported tarball digest <sha256> does not match the build stage's <sha256>`

**What it means:** The SHA-256 digest of `/work/out/package.tgz` streamed out during the
read-only `export` stage differed from the SHA-256 computed at the end of the `build` stage.

**What to try:** Re-run the check on a clean Docker volume (without sharing volumes across
processes) and verify Docker storage health.

---

## `unexpected error: <detail>`

**Message as printed:** `unexpected error: …`

**What it means:** An unexpected runtime exception occurred while orchestrating the Docker
containers (outside normal container exit codes or `ToolError` preconditions).

**What to try:** Check the error detail in the report, verify that the Docker daemon remained
responsive throughout the run, and re-run with `--json`.
