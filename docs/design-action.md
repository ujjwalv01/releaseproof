# Design: the GitHub Action (Phase 4)

Status: implemented 2026-10-18 under `action/`; self-tested by
`.github/workflows/action-self-test.yml`. `action.yml` lives at the repository root (the
Marketplace requires that) and runs the committed bundle `action/dist/index.js`, so users
write `uses: ujjwalv01/releaseproof@<sha>`.

## 1. What it does

`releaseproof/action` runs `releaseproof check` for one package version inside a workflow
and reports the verdict three ways: the job summary (always), the job status (configurable
with `fail-on`), and optionally an issue. The full JSON report is written to a file the
workflow can upload as an artifact. Outputs: `verdict`, `exit-code`, `summary`,
`report-path`, `issue-url`.

Defaults are chosen so that the common case needs no inputs at all when the action runs in
the package's own repository after a release:

- `package` and `version` come from the checkout's `package.json`.
- `repo` defaults to the current repository, so a release whose provenance names any other
  repository is a **critical** finding. This is the strongest check the action adds over the
  CLI: it knows which repository it is running in.
- `commit` defaults to `github.sha`, used only when the version has **no verified
  provenance**; the verdict then says the source was named, not certified. For a staged
  version, provenance found in the Rekor transparency log and built from `repo` counts as
  verified. Set it to the
  empty string to disable the fallback.

## 2. Threat model

The action runs untrusted builds (inside Docker, as the CLI does) on a runner that holds a
`GITHUB_TOKEN`. The job must never become the attack vector this tool detects.

| Risk | Decision |
| --- | --- |
| `pull_request_target` gives contributor-controlled code the base repository's secrets. It is how the TanStack attack started. | The action refuses to run on that event, with an explanation. A release check has no business on a pull request. |
| The token could be used to tamper with the repository. | The action needs **no permissions** by default (job summary and outputs only). `create-issue: true` needs exactly `issues: write`. The token is used for nothing else; it is never passed to the check or into Docker. |
| Package content (file paths, patch lines) ends up in markdown on GitHub, where it could inject HTML or links, or ping users with `@mentions`. | Everything from the package or the build is inside a single code fence sized longer than any backtick run in the content; the heading and summary come from our own code. |
| Issue bodies have a size limit; a huge report would be rejected or truncated unpredictably. | We truncate the fenced text to fit GitHub's limit and say so; the JSON report has everything. |
| `report-path` is an input; a crafted value could write outside the workspace. | Must be relative and may not contain `..`. |
| A stale bundle in `action/dist` would run old code while the sources say otherwise. | CI rebuilds and fails if `action/dist` differs from the commit. |
| Dependencies at runtime. | None: the bundle is self-contained. pacote was removed from the project because its dependency chain (`@npmcli/run-script`, `node-gyp`) does not survive bundling; the registry client in core does the two fetches instead. |

## 3. Recommended workflow

```yaml
name: Verify npm release
on:
  release:
    types: [published]
  workflow_dispatch:

permissions: {} # nothing; add "issues: write" only with create-issue

jobs:
  verify:
    runs-on: ubuntu-latest # Docker is available on GitHub-hosted Linux runners
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha>
        with:
          persist-credentials: false
      - uses: ujjwalv01/releaseproof@<sha>
        with:
          create-issue: "false"
      - uses: actions/upload-artifact@<sha>
        if: always()
        with:
          name: releaseproof-report
          path: releaseproof-report.json
```

Run it after the publish completes (a `release` event, or a job with `needs: publish` in the
release workflow), never on `pull_request_target`.

## 4. Layout and build

`action/src/main.ts` holds the behaviour behind an `ActionIo` interface (inputs, outputs,
summary, file writes, issue creation, the check itself) so it is tested without `@actions/*`.
`action/src/index.ts` is the only file that touches `@actions/core`, `@actions/github` and
the filesystem. `tsup` bundles everything into `action/dist/index.js` (Node 24 runtime, ESM,
with a `createRequire` banner for bundled CommonJS). `action/dist` is committed and must be
rebuilt in the same commit as any source change.
