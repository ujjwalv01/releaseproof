# The JSON report

`releaseproof check --json` prints the full report to stdout. The GitHub Action writes the
same report to `releaseproof-report.json` (or the path in its `report-path` input). Use it
to post-process a check in CI.

The shape is the `CheckReport` type in
[`packages/core/src/check/run.ts`](../packages/core/src/check/run.ts). The report holds no
tarball bytes and nothing secret.

Keys whose value is `undefined` are left out of the JSON, not written as `null`. Treat every
field marked "optional" below as possibly absent.

## Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `package` | object | The release that was checked. |
| `provenance` | object | The result of verifying the Sigstore provenance. |
| `source` | object, optional | Where the rebuild was made from. Absent when there was nothing to rebuild from. |
| `rebuild` | object, optional | The rebuild log. Absent when there was no source. |
| `diff` | object, optional | The comparison of release and rebuild. Absent unless the rebuild succeeded. |
| `verdict` | object | The decision. Read this first. |
| `durationMs` | number | Wall-clock time of the whole check, in milliseconds. |

### `package`

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Package name. |
| `version` | string | Package version. |
| `origin` | `"published"` or `"staged"` | Whether the version is on the registry or still waiting for approval. |
| `registry` | string | Registry the tarball came from. |
| `sha512` | string | SHA-512 of the release tarball, in hexadecimal. |
| `files` | number | Number of non-directory entries in the release tarball. |

### `verdict`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | string | One of the statuses below. |
| `exitCode` | `0`, `1` or `2` | The exit code the CLI and the Action use for this status. |
| `summary` | string | One line for humans. |
| `reasons` | string[] | Why the status is what it is, most important first. |
| `findings` | object[] | Rule findings, most severe first. See below. |
| `counts` | object | Number of findings per severity: `critical`, `high`, `medium`, `low`, `info`. |

| `status` | `exitCode` | Meaning |
| --- | --- | --- |
| `matches-source` | `0` | Rebuilt from the source and byte-identical, with no `critical` or `high` finding. |
| `differs-from-source` | `1` | Something an approver must look at: a file differs, or there is a `critical` or `high` finding. |
| `could-not-verify` | `2` | No verdict is possible (no source, failed rebuild, unreadable tarball). Never read this as "safe". |

The statuses are the same three that [docs/rules.md](./rules.md#verdict) describes in
prose. In CI, fail the job on anything but `matches-source`.

Each entry of `findings`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable kebab-case rule id, for example `install-script-added`. Every id is listed in [docs/rules.md](./rules.md). |
| `severity` | string | `critical`, `high`, `medium`, `low` or `info`. |
| `title` | string | Short name of the finding. |
| `detail` | string | Plain-English explanation of what was seen and why it matters. |
| `paths` | string[], optional | Package paths involved, when the finding is about files. |
| `evidence` | object, optional | Structured details (patches, old and new values). The keys depend on the rule. |

### `provenance`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | string | One of the statuses below. |
| `problems` | string[] | Why the status is not `verified`. Empty when it is. |
| `warnings` | string[] | Things worth showing that do not change the status. |
| `source` | object, optional | What a verified provenance vouches for, taken from the Sigstore certificate: `repository`, `commit`, `ref`, and optionally `workflowPath`, `workflowRef`, `trigger`, `runnerEnvironment`, `invocationUri`, `visibility`, `repositoryId`, `ownerUri`. |
| `certificate` | object, optional | Facts from the Fulcio certificate (see `CertificateIdentity` in [`provenance/types.ts`](../packages/core/src/provenance/types.ts)). |
| `predicate` | object, optional | What the build job claimed in the SLSA predicate (see `PredicateClaim`). A claim, not proof. |
| `mismatches` | object[] | Fields where the job's claim disagrees with the certificate. Each has `field`, `certificate` and `predicate`. Each one is also a finding. |
| `signerOutsideRepository` | string, optional | Set when the signing workflow lives outside the source repository (a reusable workflow). |
| `publishAttestation` | object | Result for the npm publish attestation: `status` (`verified`, `missing` or `invalid`) and optionally `keyid` and `problem`. |
| `transparencyLog` | object, optional | `logIndex` and `integratedTime`, both strings. |

| `provenance.status` | Meaning |
| --- | --- |
| `verified` | A Sigstore certificate chained to the public trust root signed the provenance, and its subject matches this tarball. `provenance.source` can be trusted. |
| `missing` | The registry has no provenance for this version. |
| `invalid` | Provenance exists but a check failed. Treat it like an attack until proven otherwise. |
| `unsupported` | Provenance exists but is a format releaseproof cannot interpret (not GitHub Actions). |

Only `verified` provenance can contribute to a `matches-source` verdict.

### `source`

| Field | Type | Meaning |
| --- | --- | --- |
| `repository` | string | `https://github.com/<owner>/<repo>`. |
| `commit` | string | Full 40-character commit SHA. |
| `ref` | string, optional | Git ref, when known. |
| `workflowPath` | string, optional | Path of the release workflow in the repository, when known. |
| `verified` | boolean | `true` when the source came from verified provenance, `false` when you named it with `--repo` and `--commit`. |

### `rebuild`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `"ok"` or `"failed"` | Whether the rebuild produced a tarball. |
| `failure` | string, optional | Why it failed. |
| `image` | string, optional | Docker image used. |
| `imageDigest` | string, optional | Full digest of that image. |
| `toolVersion` | string, optional | Package manager version used, for example `npm 10.9.9`. |
| `plan` | object, optional | The build plan: `packageDir`, `manager`, `nodeMajor`, `nodeSource`, `buildSource` and `warnings` (string[]). |
| `stages` | object[] | One entry per container stage. See below. |
| `durationMs` | number | Time spent rebuilding, in milliseconds. |

Each entry of `stages`: `stage` (`init`, `clone`, `install`, `build` or `export`), `image`,
`network` (`bridge` or `none`), `exitCode` (number or `null`), `timedOut` (boolean),
`durationMs` and `output` (the last part of the stage's output).

### `diff`

| Field | Type | Meaning |
| --- | --- | --- |
| `matches` | boolean | `true` only when nothing differs and neither archive had problems. |
| `identical` | number | Count of files that are identical. |
| `changed` | object[] | Files present in both but different. See below. |
| `onlyInRelease` | object[] | Files in the release but not in the rebuild: `{ path, size }`. |
| `onlyInRebuild` | object[] | Files in the rebuild but not in the release: `{ path, size }`. |
| `permissionDifferences` | number | Count of files that differ only in permission bits. These are normalized away and never block. |
| `problems` | object | `release` and `rebuild`, each a string[] of problems found while reading that tarball (for example suspicious entries). |

Each entry of `changed` has two fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | Path inside the package. |
| `kind` | string | `content` (bytes differ), `whitespace` (only line endings or trailing whitespace differ), `type` (file versus link versus directory) or `mode` (same bytes, different permission bits). |

The report does not carry file contents or patches for `changed` entries. A finding such
as `file-changed` can carry a patch in its `evidence`.

## Example

A trimmed report for `sigstore@5.0.0`, which matches its source. It mirrors the fixture in
[`packages/core/src/report/text.test.ts`](../packages/core/src/report/text.test.ts); the
`sha512`, `stages` and some `provenance` keys are shortened or left out.

```json
{
  "package": {
    "name": "sigstore",
    "version": "5.0.0",
    "origin": "published",
    "registry": "https://registry.npmjs.org/",
    "sha512": "849a897e81bf7b8a8541a6ae40bd3473a27a16b1cb0462ad905bd6dc96d34881…",
    "files": 9
  },
  "provenance": {
    "status": "verified",
    "problems": [],
    "warnings": [],
    "mismatches": [],
    "publishAttestation": { "status": "verified" },
    "source": {
      "repository": "https://github.com/sigstore/sigstore-js",
      "commit": "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a",
      "ref": "refs/heads/main",
      "workflowPath": ".github/workflows/release.yml",
      "trigger": "push",
      "runnerEnvironment": "github-hosted"
    }
  },
  "source": {
    "repository": "https://github.com/sigstore/sigstore-js",
    "commit": "7d2900eca1c22b3f87c13987c8d4b7c9a29b733a",
    "verified": true
  },
  "rebuild": {
    "status": "ok",
    "image": "node:22-bookworm",
    "toolVersion": "npm 10.9.9",
    "plan": {
      "packageDir": "packages/client",
      "manager": "npm",
      "nodeMajor": 22,
      "nodeSource": "default",
      "buildSource": "root \"build\" script",
      "warnings": []
    },
    "stages": [],
    "durationMs": 134000
  },
  "diff": {
    "matches": true,
    "identical": 9,
    "changed": [],
    "onlyInRelease": [],
    "onlyInRebuild": [],
    "permissionDifferences": 0,
    "problems": { "release": [], "rebuild": [] }
  },
  "verdict": {
    "status": "matches-source",
    "exitCode": 0,
    "summary": "MATCHES SOURCE: 9 files identical to a clean build of sigstore/sigstore-js@7d2900e",
    "reasons": ["9 files identical to a clean build of sigstore/sigstore-js@7d2900e"],
    "findings": [],
    "counts": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0 }
  },
  "durationMs": 140000
}
```

A report that differs has the same shape. Its `diff.changed` holds entries like
`{ "path": "lib/index.js", "kind": "content" }`, `verdict.status` is `differs-from-source`
and `verdict.findings` lists what to read before approving.

## Reading it in CI

```sh
npx releaseproof check sigstore@5.0.0 --json > report.json
jq -r '.verdict.status' report.json
jq -r '.verdict.findings[] | select(.severity == "critical" or .severity == "high") | .id' report.json
```
