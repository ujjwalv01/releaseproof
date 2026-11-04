# releaseproof

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
