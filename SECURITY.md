# Security policy

releaseproof downloads untrusted tarballs, verifies signatures and runs untrusted builds.
Bugs in those paths are security bugs. Please report them privately.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a
vulnerability"). Include the package and version you were checking, the command or
workflow, and the output. Expect an acknowledgement within a week.

Please do not open public issues for anything that could let a malicious package escape
the container, make a tampered release read as MATCHES SOURCE, or leak a token.

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
