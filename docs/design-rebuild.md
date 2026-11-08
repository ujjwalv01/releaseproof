# Design: rebuild in Docker and diff (Phase 2)

Status: implemented 2026-10-17 (`packages/core/src/rebuild`, `packages/core/src/diff`) and
verified end to end on `semver@7.8.5` and `sigstore@5.0.0`, both matching their releases
(see `docs/real-world-results.md`). Decisions here are the hard-to-reverse ones; smaller
details live in code comments and tests.

Known follow-ups: skip the dependency install when the package has no build, prepack or
prepare script (npm pack does not need node_modules then; saves minutes); bun support;
resolving `lts/*` from a maintained table instead of assuming 24.

## 1. Goal

Given a release tarball and a source reference (repository + commit, normally from verified
provenance), produce the tarball the source *would* produce, then compare the two file by
file, hiding differences that are known to be harmless and surfacing everything else.

## 2. Threat model for this step

The repository, its dependencies, their install scripts and the build scripts are **all
untrusted**: a compromised release is exactly the case where they are malicious. So:

| Rule | How |
| --- | --- |
| Package code never runs on the host. | `git clone`, dependency install, lifecycle scripts, build and pack all run inside containers. The host only parses two tarballs with its own code. |
| No secrets reach the build. | No bind mounts, no host env passthrough. Only a fresh Docker volume. The container sees `RP_*` parameters we set and nothing else. |
| Network only where the build needs it. | Stage 1 (clone) and stage 2 (fetch dependencies) have network. Stage 3 (run dependency scripts, build, pack) runs with `--network none`. |
| Limit blast radius. | `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user, `--pids-limit`, `--memory`, per-stage timeouts, then the volume is deleted. |
| Untrusted bytes stay data. | Tarballs are read with size/count limits, no symlinks or hardlinks are followed, paths with `..` or absolute paths are rejected and reported. Only text files under a size cap are diffed line by line. |
| Inputs are validated before they touch a shell. | Repository must match `https://github.com/<owner>/<repo>`, commit must be 40 hex chars, package name must be a valid npm name. Parameters are passed as environment variables to fixed scripts; nothing is interpolated into shell text. |

Not defended against: a malicious repository that breaks out of Docker Desktop itself.
That is Docker's job; we reduce exposure with the limits above and no mounts.

## 3. Pipeline

```
host                       container (volume /work, user 1000)
----                       ---------------------------------------------
validate source ──────────▶ stage 1  clone   [network]  git fetch commit; inspect repo → JSON
plan build  ◀──────────────          (no repo code runs; only git + reading files)
            ──────────────▶ stage 2  deps    [network]  install with scripts ignored
            ──────────────▶ stage 3  build   [no net]   run dep scripts, build, npm pack
read tarball ◀────────────  stage 4  export             cat /work/out/package.tgz
compare release vs rebuild
```

- **Stage 1** uses the default image (`node:22-bookworm`, has git). It fetches the exact
  commit shallowly (`git fetch --depth 1 origin <sha>`; GitHub serves any reachable SHA) and
  falls back to a full clone. Submodules are initialised when `.gitmodules` exists. It then
  prints an **inspection** JSON: root package.json, lockfiles present, `packageManager`,
  Node version files, every tracked `package.json` (name, version, private, scripts,
  publishConfig), the release workflow's text (we know its path from provenance), and
  whether submodules exist. Only `git` and file reads run here.
- **Planning** is pure TypeScript on the host (testable with fixtures), see section 4.
- **Stage 2** runs the chosen image, enables Corepack, installs with the lockfile frozen and
  **scripts ignored**: `npm ci --ignore-scripts`, `pnpm install --frozen-lockfile
  --ignore-scripts`, `yarn install --immutable --mode=skip-build` (Berry) or
  `yarn install --frozen-lockfile --ignore-scripts` (classic).
- **Stage 3** runs offline: `npm rebuild` / `pnpm rebuild` / `yarn rebuild` so dependency
  lifecycle scripts execute without network (failures are logged, not fatal), then the build
  command, then `npm pack --pack-destination /work/out`.
- **Stage 4** streams the tarball to the host over stdout (no `docker cp`, no mounts).

The default timeouts for the three main stages are defined by `DEFAULT_TIMEOUTS` in
[`packages/core/src/rebuild/run.ts`](../packages/core/src/rebuild/run.ts):

| Stage | Default timeout |
| --- | --- |
| `clone` | 10 minutes |
| `install` | 20 minutes |
| `build` | 30 minutes |

These limits apply separately to each stage, not to the rebuild as a whole.

Each stage records its command, exit code, duration and (truncated) output. Any failure or
timeout makes the rebuild `failed` with the stage name and log tail; the verdict is then
"could not verify", never "matches".

## 4. Build planning rules

**Package directory.** Among tracked `package.json` files (excluding `node_modules`), pick
the one whose `name` equals the target; if several, prefer the matching `version`. None → fail
("package not found in repository at this commit"). `private: true` → fail.

**Package manager**, in order: the `packageManager` field (package dir, then root) via
Corepack; else the lockfile at the root (`pnpm-lock.yaml` → pnpm, `yarn.lock` → Yarn, Berry
if `.yarnrc.yml` exists, classic otherwise; `package-lock.json`/`npm-shrinkwrap.json` → npm);
else npm with a warning that no lockfile makes the build non-reproducible. `bun.lock` →
unsupported in v1.

**Node version**, in order: `node-version:` of the first `actions/setup-node` step in the
release workflow (the workflow's own choice is the most faithful signal), `.nvmrc` /
`.node-version`, the lowest major allowed by `engines.node`, else 22. Image:
`node:<major>-bookworm` (full image: has git, python3, make, g++ for native addons). The
image digest actually used is recorded in the report. `--image` overrides. The CLI and
Action validate the override before starting a check, and the core rebuild validates it
before any Docker call. Common names, registry ports, tags and SHA-256 digests (including
tag-plus-digest references) are accepted. Flag-like values, whitespace/control characters
and empty names or tags are tool errors; omitting the override keeps the detected image.

If Docker reports a missing image or manifest, the tool error names the image and suggests
`--node` with a supported major or an explicit `--image`; not every major has a bookworm
image. Network, authentication and platform-mismatch failures keep their raw Docker detail.

**Build command.** If the package has a `build` script: pnpm → `pnpm --filter "<name>..." run
build` (builds workspace dependencies first, topologically); Yarn Berry → `yarn workspaces
foreach -Rt --from "<name>" run build`; npm workspaces / Yarn classic → the root `build`
script if present, else the package's. No `build` script anywhere → no build step. Users can
override with `--build-command`. `prepack` and `prepare` run inside `npm pack` as npm does.

**Pack tool: the project's own package manager.** Checked against real releases at their
provenance commits (2026-10-17): `@tanstack/query-core@5.104.3` and `vitest@5.0.5` (pnpm)
differ from the repository `package.json` only in dependency specifiers — `workspace:*`
becomes the sibling's version, `catalog:` becomes the catalog range — while `sigstore@5.0.0`
(npm) is identical, with no `gitHead` added. pnpm and Yarn do these rewrites (plus
`publishConfig` overrides) inside `pnpm pack` / `yarn pack`, so using the same tool as the
maintainer reproduces them exactly; emulating them would drift as the tools evolve.
Commands: `npm pack --pack-destination /work/out`, `pnpm pack --pack-destination /work/out`,
`yarn pack --out /work/out/package.tgz` (Berry), `yarn pack --filename …` (classic).
Any remaining package.json difference is shown as a change.

**Learned from real packages (2026-10-18).** `pnpm --filter <name>` never matches the
workspace root, so a root pnpm package is built with a plain `pnpm run build`. Package
scripts call `pnpm`/`yarn` by name (tsx's `prepack` runs `pnpm build`), so the install
stage writes Corepack shims into `/work/home/bin` and caches the exact version
(`corepack install -g`), and every stage puts that directory on `PATH`. Corepack refuses to
run in a project whose `packageManager` field it cannot parse (zod: `nub@0.8.3`), so
`COREPACK_ENABLE_PROJECT_SPEC=0` is set; we always name the exact tool ourselves. Release
tooling such as semantic-release sets the version at publish time (tsx commits
`0.0.0-semantic-release`), so when the commit's version differs from the release the build
stage runs `npm pkg set version=<released>` before packing; the low `version-not-in-source`
finding still records it.

Lerna repositories without npm `workspaces` (actions/toolkit) keep a lockfile per package
and build with `lerna run <script>` at the root: `lerna.json` counts as a workspace marker,
the root build script is parsed for the per-package script name (`tsc` in toolkit's case),
the package's own `npm ci` runs after the root one, and only that package's script runs.
Memory: tsup's `.d.ts` worker ran out of JS heap in a 3.9 GB Docker Desktop VM while the same
build passes on GitHub's 7 GB runners; the container limit is exposed as `--memory` /
the `memory` input (default 4g), and the VM must have at least that much.

## 5. Comparison and normalization

Both tarballs are parsed into `path → { type, size, mode, sha256, content? }` maps; the
first path segment (`package/`) is stripped and recorded.

Ignored (never reported): mtime (npm pins it to 1985-10-26), uid/gid/uname/gname, entry
order, gzip-level differences, trailing padding. Reported as **info**: mode differences that
do not change executability. Reported as **differences**: files only in the release, files
only in the rebuild, content differences (with a unified diff for text files up to 1 MB,
hash-only beyond), type differences (file vs directory vs link), executable bit changes.

Text files are compared byte-exact; when they differ only in line endings or trailing
whitespace the difference is labelled `whitespace` so Phase 3 can rank it low without hiding
it. Binary detection: a NUL byte in the first 8 KB.

Limits (exceeding any is itself reported): 20 000 entries, 512 MB unpacked, 64 MB per
file kept in memory for hashing (larger files are hashed streaming, content not kept).

## 6. What can still differ legitimately (to measure in Phase 5)

Build banners with dates, absolute paths in source maps, bundler-generated hashes, Node
version-dependent output, `gitHead` when the release was packed outside a git checkout,
pnpm `publishConfig` rewrites we did not anticipate. Each one found in the real-world runs
becomes either a normalization rule (if provably harmless) or stays visible.

## 7. Decisions

| # | Decision | Why |
| --- | --- | --- |
| R1 | Clone inside the container, not on the host. | Crafted repositories have exploited git itself (e.g. CVE-2024-32002). The host never touches repo contents except the final tarball bytes. |
| R2 | Four stages on one volume; build stage has no network. | Dependency and build scripts cannot exfiltrate or fetch payloads; the install stage runs with scripts ignored, so the only networked code is git, npm/pnpm/yarn themselves. |
| R3 | Parameters via `RP_*` env vars into fixed scripts; strict validation first. | No shell interpolation of attacker-influenced strings. |
| R4 | Planning on the host from an inspection JSON. | Pure, unit-testable logic; the container does no decision making. |
| R5 | Pack with the project's own package manager. | pnpm/Yarn rewrite `workspace:`/`catalog:` specifiers and `publishConfig` at pack time (verified on real releases); the maintainer's tool is the only faithful reproduction. |
| R6 | Node major from the release workflow first. | It is what actually built the release. |
| R7 | Floating `node:<major>-bookworm` tags, digest recorded. | Pinning digests in our code would go stale within weeks; recording keeps runs explainable. |
| R8 | Rebuild failure is "could not verify" (exit 2), not "differs" (exit 1). | A failed build proves nothing either way; fail closed without crying wolf. |
| R9 | Stream the tarball out over stdout; no bind mounts anywhere. | Nothing on the host is ever writable from the container. |
| R10 | Tarball parsing with hard limits and no link following. | Zip-bomb and path-traversal style tarballs must not hurt the host. |
