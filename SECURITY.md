# Security policy

releaseproof downloads untrusted tarballs, verifies signatures and runs untrusted builds.
Bugs in those paths are security bugs. Please report them privately.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a
vulnerability"). Include the package and version you were checking, the command or
workflow, and the output. Expect an acknowledgement within a week.

Please do not open public issues for anything that could let a malicious package escape
the container, make a tampered release read as MATCHES SOURCE, or leak a token.

## Supported versions

While releaseproof is in `0.x`, only the latest released minor of the
[`releaseproof` npm package](https://www.npmjs.com/package/releaseproof) and its
matching GitHub Action version tag receive security fixes. Older minor versions
are not supported.

Fixes ship as new releases through the
[staged publishing workflow](./.github/workflows/release.yml): the staged package
is verified before a maintainer approves it with 2FA. Existing commit SHAs and
version tags do not change, so update your pinned SHA or tag to receive a fix.

Find the current published version on [npm](https://www.npmjs.com/package/releaseproof)
and its release notes in the [CLI changelog](./packages/cli/CHANGELOG.md).

## What releaseproof promises

- Package code never runs on the machine that runs releaseproof. Clone, install, build and
  pack happen inside Docker with no host mounts, no secrets, dropped capabilities, and no
  network during the build stage.
- "Could not verify" is never reported as safe.
- Nothing about your package leaves your machine or CI: the only network calls go to the
  registry, GitHub (to clone), the Sigstore trust root and the Docker image registry, and,
  for a staged version, the Rekor transparency log, which receives the tarball's SHA-512
  (`--no-rekor` turns that lookup off).
- Tokens are used only to talk to the npm registry (and, in the Action, to open an issue
  when asked). They are never passed into containers.

## Scope

In scope: the CLI, the core library, the GitHub Action and its workflows in this repository.
Out of scope: Docker Desktop and the Node.js runtime themselves; the registries and
services releaseproof talks to.
