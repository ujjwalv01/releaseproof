# releaseproof

## 0.3.0

### Minor Changes

- [#212](https://github.com/ujjwalv01/releaseproof/pull/212) [`78b4156`](https://github.com/ujjwalv01/releaseproof/commit/78b4156b0991f62a664787615471456eedcbd08d) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Expose `findings` and `highest-severity` outputs from the GitHub Action so workflows can branch on finding counts and severity without parsing `releaseproof-report.json`.

- [#221](https://github.com/ujjwalv01/releaseproof/pull/221) [`a20747c`](https://github.com/ujjwalv01/releaseproof/commit/a20747c49ceb888067edc55e134676519bdf5673) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Add `rekor` input to the GitHub Action (default: `"true"`) to allow skipping Rekor transparency log lookups for staged versions, matching the CLI's `--no-rekor`.

- [#209](https://github.com/ujjwalv01/releaseproof/pull/209) [`0148112`](https://github.com/ujjwalv01/releaseproof/commit/0148112ae58a731fdf300c20dc4c7aff42b6ab91) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Add `--patch-lines <n>` to `releaseproof check` to control how many diff lines are shown per changed file in the text report (`0` for none).

- [#199](https://github.com/ujjwalv01/releaseproof/pull/199) [`13dee10`](https://github.com/ujjwalv01/releaseproof/commit/13dee101536f75307c1fc4d97b1c8b143e83e2b7) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Add `--report <path>` to `releaseproof check` to write the pretty-printed JSON report to a file alongside the normal stdout output.

### Patch Changes

- [#226](https://github.com/ujjwalv01/releaseproof/pull/226) [`b3598bc`](https://github.com/ujjwalv01/releaseproof/commit/b3598bcd312154c1512488572a286fd0e4362bb9) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Accept versions with a leading `v` or `=` (such as `v1.2.3`) in the CLI and GitHub Action, reject build metadata that npm never publishes, and validate the spec before logging the fetch step.

- [#229](https://github.com/ujjwalv01/releaseproof/pull/229) [`0649403`](https://github.com/ujjwalv01/releaseproof/commit/0649403535c50097d305d09a499ba77e1b78859d) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Reuse an existing open issue with the same title and labels in the GitHub Action (`create-issue: "true"`) by commenting on it instead of opening a duplicate issue on every run.

- [#210](https://github.com/ujjwalv01/releaseproof/pull/210) [`568612f`](https://github.com/ujjwalv01/releaseproof/commit/568612f691f575dced2d1217debefcd45242822c) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Link each finding in the Action job summary and issue body directly to its rule anchor on the documentation website (`rules.html#<id>`).

- [#225](https://github.com/ujjwalv01/releaseproof/pull/225) [`f36e0da`](https://github.com/ujjwalv01/releaseproof/commit/f36e0daabd4753e6c6f4c4bfab6fe4e6a97b9900) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Raise `dependency-changed` severity to `high` when a registry dependency range is repointed to a non-registry URL (git, tarball, `file:`, `link:`, `owner/repo` shorthand) or `npm:` package alias.

- [#177](https://github.com/ujjwalv01/releaseproof/pull/177) [`a3c2a17`](https://github.com/ujjwalv01/releaseproof/commit/a3c2a172e1d860fa1276fd8318ce029f7bc1f55a) Thanks [@jeelthacker1](https://github.com/jeelthacker1)! - Accept legacy npm package names containing uppercase letters while preserving their published casing in registry requests and attestation identifiers.

- [#218](https://github.com/ujjwalv01/releaseproof/pull/218) [`a28ab64`](https://github.com/ujjwalv01/releaseproof/commit/a28ab646792613b675bbad75ff952b42dfeb1e1a) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Log a progress note when verified provenance certifies a source commit and a different `--commit` value is ignored.

- [#217](https://github.com/ujjwalv01/releaseproof/pull/217) [`e8d53a1`](https://github.com/ujjwalv01/releaseproof/commit/e8d53a184c5049e64f73458f6789c9f0717b278e) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Require a `k`, `m` or `g` unit and at least 6 MiB (Docker's minimum) for `--memory` and the Action's `memory` input so `0` or unitless byte counts cannot disable or break container memory limits.

- [#224](https://github.com/ujjwalv01/releaseproof/pull/224) [`65c03af`](https://github.com/ujjwalv01/releaseproof/commit/65c03aff8f5751a39c88eca779e9668e26aa5b86) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Add an actionable hint to the `was not found` registry error for just-published and staged versions, and document how to sequence the GitHub Action after `npm publish`.

- [#228](https://github.com/ujjwalv01/releaseproof/pull/228) [`b35d12b`](https://github.com/ujjwalv01/releaseproof/commit/b35d12be3b99597c4e98ad4689984733ffee18c7) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Handle Node.js aliases (`lts/*`, `latest`, `current`, `node`) and older LTS codenames (`lts/gallium`, `lts/fermium`) in `.nvmrc` and `.node-version`, and add a build plan warning when a version file cannot be parsed.

- [#179](https://github.com/ujjwalv01/releaseproof/pull/179) [`be058db`](https://github.com/ujjwalv01/releaseproof/commit/be058db43badd5acdd8298dce6c767256fa6eaf7) Thanks [@jeelthacker1](https://github.com/jeelthacker1)! - Require explicit package and version inputs for published checks against private monorepo roots, instead of looking up an unpublished root package. Stage-only checks can still omit the package spec.

- [#223](https://github.com/ujjwalv01/releaseproof/pull/223) [`067c883`](https://github.com/ujjwalv01/releaseproof/commit/067c883ee0e216a9d440d33855c582b3b02601e6) Thanks [@aviraltrip](https://github.com/aviraltrip)! - Reject registry URLs containing embedded user names or passwords so credentials are never echoed in errors or sent to fetch.

- [#178](https://github.com/ujjwalv01/releaseproof/pull/178) [`3f92669`](https://github.com/ujjwalv01/releaseproof/commit/3f9266954e50f1db2f99a799cbac0d8143a703e9) Thanks [@jeelthacker1](https://github.com/jeelthacker1)! - Analyze scripts starting with a shebang for obfuscation and minification when the rebuild does not produce their contents, even if the file has no known code extension.

- [#219](https://github.com/ujjwalv01/releaseproof/pull/219) [`6b5d3ea`](https://github.com/ujjwalv01/releaseproof/commit/6b5d3ea826e39f11d8b33b3d9a22a59a45038569) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Strictly validate `--node` and the Action's `node` input with shared `parseNodeMajorOption` to reject non-decimal literals such as `0x16`, `1e1` and `22.0`.

- [#227](https://github.com/ujjwalv01/releaseproof/pull/227) [`0648258`](https://github.com/ujjwalv01/releaseproof/commit/0648258d90e07c8aedbfc86e0e82bdb5a1a102df) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Include the stage time limit in timed-out rebuild failure messages (e.g. `build stage timed out after 30 min` or `after 90 s`).

- [#216](https://github.com/ujjwalv01/releaseproof/pull/216) [`3b81e19`](https://github.com/ujjwalv01/releaseproof/commit/3b81e19c09645c845a24860c795428ae19279638) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Flag `.env.*` variants (excluding `.env.example`, `.env.sample` and `.env.template`), nested `.env` and `.npmrc` files, and `id_dsa` / `id_ecdsa` / `id_ed25519` (including `_sk`) SSH private keys in `unexpected-path`.

- [#208](https://github.com/ujjwalv01/releaseproof/pull/208) [`107eef0`](https://github.com/ujjwalv01/releaseproof/commit/107eef0b306d73790b51a224fe6b3c0444b17ab0) Thanks [@Burakceliks](https://github.com/Burakceliks)! - Validate `--report` parent directory and target path writability before running the check so unwritable paths fail immediately instead of after a rebuild.

## 0.2.2

### Patch Changes

- [#109](https://github.com/ujjwalv01/releaseproof/pull/109) [`70d3da8`](https://github.com/ujjwalv01/releaseproof/commit/70d3da8abe9fd133c68e1900f073af86241eff2f) Thanks [@bfs2021](https://github.com/bfs2021)! - The Action now sets the `verdict`, `exit-code` and `summary` outputs, writes a job summary
  and opens its issue (when `create-issue` is enabled) even when the check itself fails with
  a tool error such as an unreachable registry or a missing Docker daemon. Previously those
  runs only called `setFailed` and left the outputs empty.

- [#69](https://github.com/ujjwalv01/releaseproof/pull/69) [`ba42309`](https://github.com/ujjwalv01/releaseproof/commit/ba423099f21d790670a6eb71cc361d598e3c2db6) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Recognize GitHub repository URLs with uppercase schemes and hosts when comparing provenance repositories.

- [#156](https://github.com/ujjwalv01/releaseproof/pull/156) [`a65d298`](https://github.com/ujjwalv01/releaseproof/commit/a65d2986d49a8e6b73ca00bf7175fbb6c8699ba4) Thanks [@sshnox](https://github.com/sshnox)! - Exit with code 2 for invalid CLI usage so scripts can distinguish it from a release mismatch.

- [#103](https://github.com/ujjwalv01/releaseproof/pull/103) [`06931a9`](https://github.com/ujjwalv01/releaseproof/commit/06931a9455c1544e286fdb2cd55357d71fe1143f) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Flag credential-looking files and directories as unexpected package paths, even when the source rebuild contains them too.

- [#158](https://github.com/ujjwalv01/releaseproof/pull/158) [`eca9ccb`](https://github.com/ujjwalv01/releaseproof/commit/eca9ccbd82eda3db055668edcaac20a1cb66d483) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - Action job summaries and issues now show the verdict summary inside a code block, so archive
  entry paths or provenance text it quotes can no longer render as links, mentions or images.
  The package name in the heading and the issue title is shown only when it is a valid npm name
  and version; a malformed one from the registry is replaced by a note.

- [#70](https://github.com/ujjwalv01/releaseproof/pull/70) [`9730117`](https://github.com/ujjwalv01/releaseproof/commit/97301179638b9fa667616d46be94f34e1d83447a) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Explain how to obtain a full commit SHA when a short hexadecimal commit is supplied,
  without resolving or accepting abbreviated commits automatically.

- [#132](https://github.com/ujjwalv01/releaseproof/pull/132) [`c1175be`](https://github.com/ujjwalv01/releaseproof/commit/c1175be426e693be4121b019512ac9c9f05784dd) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Explain whether the Docker command is missing from PATH or its daemon is not running,
  while retaining the original error detail and fallback message for other failures.

- [#100](https://github.com/ujjwalv01/releaseproof/pull/100) [`be0f666`](https://github.com/ujjwalv01/releaseproof/commit/be0f66697616f1e562bc5e05886bcaaafea6b260) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Validate and normalize --memory before starting a check, using the same Docker-size
  parser as the Action, and report invalid values as immediate tool errors.

- [#133](https://github.com/ujjwalv01/releaseproof/pull/133) [`4b13385`](https://github.com/ujjwalv01/releaseproof/commit/4b1338548759d86b34a7b03f344069f7e9ad8c3a) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Explain missing Docker images with the image name and suggestions to use a supported Node major or an explicit image. Preserve unrelated pull errors.

- [#75](https://github.com/ujjwalv01/releaseproof/pull/75) [`ed376c5`](https://github.com/ujjwalv01/releaseproof/commit/ed376c58d2e686118010f111e51fab73fd3200eb) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Report malformed clone-stage inspection paths containing NUL as an inspection
  failure before invoking rebuild commands.

- [#98](https://github.com/ujjwalv01/releaseproof/pull/98) [`0df0eca`](https://github.com/ujjwalv01/releaseproof/commit/0df0eca31de656e8168a37de96c35ce79df8dd8e) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Reject registry signing key lists whose expiry is not a valid date string (an unparseable string, a number, a boolean, an object or an array) instead of treating the malformed key as non-expiring. Only an absent or null expiry means the key does not expire.

- [#128](https://github.com/ujjwalv01/releaseproof/pull/128) [`530f93c`](https://github.com/ujjwalv01/releaseproof/commit/530f93c5692dd8220e782b81f3c9d2bff98a4150) Thanks [@bfs2021](https://github.com/bfs2021)! - Print one `{"error":{"message":…}}` object to stdout when `check --json` ends in a tool error, so scripts piping stdout can see what went wrong instead of an empty stream.

- [#126](https://github.com/ujjwalv01/releaseproof/pull/126) [`25fd4a4`](https://github.com/ujjwalv01/releaseproof/commit/25fd4a4d47c5a219f14d1f71e72dc2fee50a07a4) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - List distinct finding IDs in Action summaries and issue bodies with severity, duplicate
  counts and links to the rule documentation, within the report size budget.

- [#102](https://github.com/ujjwalv01/releaseproof/pull/102) [`bce79e3`](https://github.com/ujjwalv01/releaseproof/commit/bce79e391d85f36f9545e4c193274289b9079658) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Explain how to supply an exact version when a valid package name is given without one, including scoped names and an npm view command for that name.

- [#101](https://github.com/ujjwalv01/releaseproof/pull/101) [`ce4cdef`](https://github.com/ujjwalv01/releaseproof/commit/ce4cdefd2f8dcad3e6f529bad137a4c24a36d74d) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Clarify that `--offline` only makes Sigstore prefer its cached trust root, which is still
  fetched when the cache is missing or expired; registry, source, image, dependency and
  staged Rekor requests can still use the network.

- [#172](https://github.com/ujjwalv01/releaseproof/pull/172) [`88a28f8`](https://github.com/ujjwalv01/releaseproof/commit/88a28f800fefe7e699ddf71d0d8d65f9c8096324) Thanks [@sridhar007-ah](https://github.com/sridhar007-ah)! - Rebuild projects whose `pnpm-lock.yaml` has `lockfileVersion: 5.3` with pnpm 6 instead of pnpm 10, which rejects that lockfile. When `packageManager` names npm, pnpm or Yarn without an exact version (for example `npm@latest` or `pnpm@^9`), say that an exact version is needed instead of calling the package manager unsupported.

- [#173](https://github.com/ujjwalv01/releaseproof/pull/173) [`60d3789`](https://github.com/ujjwalv01/releaseproof/commit/60d37896208346ec5527c19f107ba4fc7d76975f) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - A publish attestation signed with a registry key that npm has since rotated is no longer reported as invalid. Key expiry is now checked against the time the transparency log recorded the signature (covered by Rekor's signed entry timestamp), as `npm audit signatures` does, so packages published with provenance before January 2025 no longer get a false `publish-attestation-invalid` and DIFFERS FROM SOURCE.

- [#135](https://github.com/ujjwalv01/releaseproof/pull/135) [`32599be`](https://github.com/ujjwalv01/releaseproof/commit/32599be42c75c5018bdc4da4b1fca0193504eb6f) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Refuse to send registry bearer tokens over non-loopback HTTP, with an HTTPS hint. Keep local HTTP registries and unauthenticated HTTP requests working.

- [#51](https://github.com/ujjwalv01/releaseproof/pull/51) [`abc66ed`](https://github.com/ujjwalv01/releaseproof/commit/abc66edd0d5d8cf7a51d65c4f8ec86e5f97d783e) Thanks [@ShahadatTest](https://github.com/ShahadatTest)! - `tarball-problem`: a release tarball that was cut off at the entry or size limit is no longer explained as links or path traversal. The detail now says which kind of problem was found.

- [#127](https://github.com/ujjwalv01/releaseproof/pull/127) [`f156670`](https://github.com/ujjwalv01/releaseproof/commit/f1566704cfae86875f5e3101547cc0522b3dbf10) Thanks [@Doomguy-BFG9000](https://github.com/Doomguy-BFG9000)! - Reject malformed image overrides as tool errors before starting a CLI or Action check
  or making a Docker call, while accepting common registry, tag and SHA-256 digest references.

- [#159](https://github.com/ujjwalv01/releaseproof/pull/159) [`1ca275d`](https://github.com/ujjwalv01/releaseproof/commit/1ca275d8e37de855e1fa015bd6fa3f7a91af23c7) Thanks [@bfs2021](https://github.com/bfs2021)! - `releaseproof check` now rejects a malformed `--repo` (such as `github.com/o/r` without a
  scheme, or plain `nope`) with a clear tool error before it fetches anything. Previously the
  unreadable expectation was compared against the certified repository and produced a false
  `provenance-repository-unexpected` critical finding, plus a Rekor lookup that matched no
  entries. `https://github.com/o/r`, `o/r` and `git+https://github.com/o/r.git` keep working.

## 0.2.1

### Patch Changes

- [#38](https://github.com/ujjwalv01/releaseproof/pull/38) [`2a345f8`](https://github.com/ujjwalv01/releaseproof/commit/2a345f8f46ba4f74a0c92ef5ab0ed9f634ac4f9b) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - `releaseproof check --help` lists the exit codes: 0 matches source, 1 differs from source, 2 could not verify or a tool error.

- [#40](https://github.com/ujjwalv01/releaseproof/pull/40) [`0a38db9`](https://github.com/ujjwalv01/releaseproof/commit/0a38db9c77a961a30aacba3f33872574e2e4b650) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - On a Node.js older than 22.12 the CLI now stops with `releaseproof needs Node.js 22.12 or newer; you are running <version>` and exit code 2, instead of failing inside a dependency with a confusing error.

- [`a5d3e3e`](https://github.com/ujjwalv01/releaseproof/commit/a5d3e3e9ca4ab0ce09bff11c0aa35938908d8b80) Thanks [@Vamsi-2581](https://github.com/Vamsi-2581)! - Show rebuild durations of one hour or longer as hours, minutes, and seconds in text reports.

- [#39](https://github.com/ujjwalv01/releaseproof/pull/39) [`7cd629d`](https://github.com/ujjwalv01/releaseproof/commit/7cd629d5fe20b2047263169943ce2010b2d4a3e4) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - `releaseproof check --token` now prints a warning on stderr: a token on the command line ends up in shell history and process lists, so prefer `NPM_TOKEN` or `npm login`. `--quiet` suppresses it.

## 0.2.0

### Minor Changes

- [#36](https://github.com/ujjwalv01/releaseproof/pull/36) [`5beb3c5`](https://github.com/ujjwalv01/releaseproof/commit/5beb3c5e79f6607741708221b6a3445f4fd01671) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - Staged versions: look the provenance up in the Rekor transparency log by the tarball's SHA-512 and verify it like a registry attestation. A verified entry built from `--repo` certifies the source before approval; `--no-rekor` turns the lookup off.

### Patch Changes

- [#22](https://github.com/ujjwalv01/releaseproof/pull/22) [`05c46ed`](https://github.com/ujjwalv01/releaseproof/commit/05c46edf5566b458211a9bf90225572f865d2fef) Thanks [@abhijeetmhaske295-blip](https://github.com/abhijeetmhaske295-blip)! - Text report: link to the Rekor transparency log entry (with its integration time) when the provenance is verified.

- [#19](https://github.com/ujjwalv01/releaseproof/pull/19) [`f6af3b9`](https://github.com/ujjwalv01/releaseproof/commit/f6af3b9f98c6f69d59cd4d9da6ec18dc57f568f5) Thanks [@Golden007-prog](https://github.com/Golden007-prog)! - Show the Docker image digest in text rebuild reports, shortened to 16 hexadecimal characters. JSON reports retain the full digest.

## 0.1.1

### Patch Changes

- [`fb219f7`](https://github.com/ujjwalv01/releaseproof/commit/fb219f7b38854c0ed4e1707a5b461e4523255534) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - First release through npm staged publishing: built in GitHub Actions, staged with
  provenance by a stage-only trusted publisher, checked by releaseproof's own action
  against the staged tarball, then approved with 2FA. No code changes; the README now
  documents `npx releaseproof check <name>@<version>`.

## 0.1.0

### Minor Changes

- [`eb5b932`](https://github.com/ujjwalv01/releaseproof/commit/eb5b932aba0fdb5742447f9b72e3e807278b5937) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - First release. `releaseproof check <name>@<version>` fetches a published (or, with
  `--stage`, a staged) npm version, verifies its provenance against the Sigstore trust root,
  rebuilds it from the certified commit in a hardened Docker container, compares the two
  tarballs file by file, and reports a verdict with graded findings: MATCHES SOURCE (0),
  DIFFERS FROM SOURCE (1) or COULD NOT VERIFY (2).
