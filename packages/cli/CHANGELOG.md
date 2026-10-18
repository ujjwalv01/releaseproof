# releaseproof

## 0.1.0

### Minor Changes

- [`eb5b932`](https://github.com/ujjwalv01/releaseproof/commit/eb5b932aba0fdb5742447f9b72e3e807278b5937) Thanks [@ujjwalv01](https://github.com/ujjwalv01)! - First release. `releaseproof check <name>@<version>` fetches a published (or, with
  `--stage`, a staged) npm version, verifies its provenance against the Sigstore trust root,
  rebuilds it from the certified commit in a hardened Docker container, compares the two
  tarballs file by file, and reports a verdict with graded findings: MATCHES SOURCE (0),
  DIFFERS FROM SOURCE (1) or COULD NOT VERIFY (2).
