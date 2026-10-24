# releaseproof

## 0.1.2

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
