# Rules and verdicts

What `releaseproof check` reports, and how the verdict is decided. Every rule is a pure
function of the release tarball, the rebuilt tarball, the diff and the provenance result;
the same inputs always produce the same findings.

## Verdict

| Verdict | Exit code | When |
| --- | --- | --- |
| `MATCHES SOURCE` | 0 | Rebuilt from the source, every file byte-identical after normalization, and no `critical` or `high` finding. Lower-severity notes can still be present and are listed. |
| `DIFFERS FROM SOURCE` | 1 | Any file differs (changed, missing or added), or any `critical`/`high` finding, even when the files match (for example a forged provenance claim). |
| `COULD NOT VERIFY` | 2 | No source to rebuild from (no verified provenance and no `--repo`/`--commit`), the rebuild failed, or a tarball could not be read. Never read this as "safe"; findings that need attention are still listed. |

The same statuses, findings and exit codes appear in the machine-readable report; see
[json-report.md](./json-report.md).

Normalization ignores timestamps, ownership, entry order, compression and permission bits
(the last are shown as info). Everything else counts.

The source for the rebuild is the commit named by verified provenance. If there is no
verified provenance, `--repo` and `--commit` name it, and the verdict says the source was
"named by you, not certified by provenance". With verified provenance, `--repo` is an
expectation: a release built from any other repository is `critical`.

## Severities

- **critical** — an attack signature on its own.
- **high** — a strong indicator that must be explained before approving.
- **medium** — needs a look.
- **low** — context; usually build-environment noise.
- **info** — facts worth knowing, not problems.

## Provenance rules

| Id | Severity | Triggers when |
| --- | --- | --- |
| `provenance-invalid` | critical | An attestation exists but fails verification (signature, subject digest, certificate checks). |
| `provenance-claim-mismatch` | critical | The SLSA predicate (written by the build job from environment variables) disagrees with the Fulcio certificate (issued from GitHub's OIDC token) on repository, commit, ref, workflow, trigger, run or builder. |
| `provenance-repository-unexpected` | critical | The certified repository is not the one given with `--repo`. |
| `provenance-repository-differs-from-manifest` | high | The certified repository is not the `repository` field of package.json. |
| `provenance-trigger-unusual` | high | The release workflow ran on an event other than push, release, workflow_dispatch, create or schedule (for example `pull_request_target`). |
| `provenance-ref-unusual` | high | The build ref is not a branch or a tag (for example `refs/pull/…`). |
| `publish-attestation-invalid` | high | The registry's own publish attestation does not verify. |
| `provenance-unsupported` | medium | Provenance exists but is not GitHub Actions / SLSA v1. |
| `provenance-missing` | medium | The registry has no attestations for the version. |
| `provenance-signer-outside-repository` | medium | The signing workflow lives in another repository (shared reusable release workflows). |
| `provenance-runner-self-hosted` | low | Built on a self-hosted runner. |
| `publish-attestation-missing` | low | Provenance verifies but there is no registry publish attestation. |
| `provenance-note` | info | Warnings from verification, such as ignored unknown attestation types. |

## package.json rules

Compared field by field against the rebuilt package.json; key order never counts.

| Id | Severity | Triggers when |
| --- | --- | --- |
| `manifest-unreadable` | critical | The release's package.json is missing, not JSON, or not an object. |
| `install-script-added` | critical | `preinstall`, `install` or `postinstall` exists in the release but not in the source. |
| `install-script-changed` | critical | One of those scripts differs from the source. |
| `lifecycle-script-added` / `-changed` | high | `prepare`, `prepublish`, `prepublishOnly`, `prepack`, `postpack`, `preprepare` or `postprepare` added or changed. |
| `dependency-added` | high | A dependency (any of dependencies, optional, peer, bundled) the source does not have. |
| `entry-point-changed` | high | `main`, `module`, `browser`, `exports`, `bin`, `types`, `typings` or `imports` differ. |
| `rebuild-manifest-unreadable` | high | The rebuilt package.json could not be read, so nothing could be compared. |
| `install-script-present` | medium / info | An install script exists. Medium when there is no rebuild to compare with; info when it is identical to the source. |
| `dependency-changed` | medium | A dependency's range differs. |
| `manifest-field-changed` | medium | Any other top-level field differs (version bumps by release tooling show up here). |
| `dependency-removed` | low | The source has a dependency the release lacks. |
| `script-changed` | low | Non-lifecycle scripts differ. |
| `manifest-formatting-changed` | low | Same fields and values, different bytes. |

## File rules

| Id | Severity | Triggers when |
| --- | --- | --- |
| `tarball-problem` | critical | The release tarball contains links, absolute paths, `..`, duplicates, unsupported entry types or mixed top-level directories. |
| `native-code-added` | critical | `.node`, `binding.gyp`, `.so`, `.dll`, `.dylib`, `.exe`, `.a` or `.lib` files the rebuild did not produce byte-for-byte. |
| `obfuscated-code-added` | critical | Code the source does not produce that shows obfuscation signals: hex-named identifiers (`_0x…`), many hex/unicode escapes, dynamic evaluation plus encoded payloads. |
| `file-type-changed` | critical | A file in the source is a link or directory in the release, or vice versa. |
| `file-added` | high | Files in the release that a clean build does not produce. |
| `file-changed` | high | Files whose content differs; a unified diff is attached for text files up to 1 MB. |
| `binary-added` | high | Added files that are binary and not an image, font or similar asset. |
| `minified-code-added` | high | Minified code the rebuild did not produce. |
| `unexpected-path` | high / medium | `.github/`, `.vscode/`, `.idea/`, `.claude/`, `.cursor/`, `CLAUDE.md`-style files, `.git/`, `.env`, `.npmrc`, `.husky/`. Medium when the source produces them too. |
| `file-missing` | medium | Files a clean build produces that the release lacks. |
| `native-code-present` | info / medium | Native code identical to the source (info), or present with no rebuild to compare with (medium). |
| `file-changed-whitespace` | low | Only line endings or trailing whitespace differ. |

## Source rules

| Id | Severity | Triggers when |
| --- | --- | --- |
| `version-not-in-source` | low | The commit's package.json has a different version than the release. |
| `no-lockfile` | low | The repository has no lockfile, so dependency versions are not pinned. |
| `rebuild-note` | info | Other planner notes, such as git submodules being used. |
