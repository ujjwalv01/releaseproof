# Frequently asked questions

This FAQ covers the questions that come up most often after a first run. For the full rules
and report format, see [docs/rules.md](rules.md) and [docs/json-report.md](json-report.md).

---

## How do I read the text report?

This is the text printed by a successful [Action self-test for `sigstore@5.0.0`](https://github.com/ujjwalv01/releaseproof/actions/runs/42051574936/job/127328739061).
Timing and the container image digest can change between runs.

```text
releaseproof check sigstore@5.0.0

Package      sigstore@5.0.0 (registry.npmjs.org), 9 files, sha512 849a897e81bf…
Provenance   VERIFIED  sigstore/sigstore-js@7d2900e on refs/heads/main
             workflow .github/workflows/release.yml, trigger push, github-hosted runner
             log https://search.sigstore.dev/?logIndex=1697019812, integrated 2026-06-01T21:02:50.000Z
Rebuild      OK (43s)  node:22-bookworm, npm 10.9.9, build: "build" script of packages/client (run from the root)
             image digest node@sha256:e273cf2a19c7334c…
Files        9 identical, 0 changed, 0 only in release, 0 only in rebuild

Findings     none

Verdict: MATCHES SOURCE: 9 files identical to a clean build of sigstore/sigstore-js@7d2900e
```

Read it from top to bottom:

| Line | Meaning |
| --- | --- |
| `releaseproof check …` | The heading identifies the package and version being checked; it does not repeat all command-line options. |
| `Package` | The package/version, registry host, number of non-directory entries in the release tarball, and an abbreviated SHA-512 of that tarball. A staged version also has `staged` beside the registry host. |
| `Provenance VERIFIED` | The provenance's Sigstore signature and its subject's match to the downloaded tarball were verified; the repository, shortened commit and ref come from the certificate. This verifies the source identity, not that the source is harmless or that the rebuild matches. |
| `workflow …, trigger …, … runner` | Known certificate details: which workflow built the release, which event triggered it, and whether its runner was GitHub-hosted or self-hosted. Missing details are omitted. |
| `log https://search.sigstore.dev/…` | A link to the verified bundle's Rekor transparency-log entry by log index, with its integration time in UTC when that time is valid. This is the provenance entry's timestamp, not the time of this check; the line is omitted without a valid log index. |
| `Rebuild OK (43s)` | The rebuild succeeded, taking 43 seconds; the rest names the Docker image tag, package manager/version and selected build script. This duration covers the rebuild, not the whole check. |
| `image digest …` | The exact Docker image used, identified by its content digest rather than its movable tag; it pins the container image, not the package tarball. The text abbreviates the digest; [the JSON report](json-report.md#rebuild) keeps it in full, and the line is absent if Docker did not provide one. |
| `Files` | Counts of non-directory paths: identical entries, entries present in both but changed, entries only in the release, and entries only in the rebuild. Archive metadata such as timestamps, ownership and ordering is ignored; permission-only differences have a separate ignored count when present (see [normalization and verdict rules](rules.md#verdict)). |
| `Findings none` | No rules produced findings for this check; otherwise this line gives the total and counts by severity. Each finding below it has a severity and rule id, a title, a distinct detail when available, and relevant paths or text patches; [docs/rules.md](rules.md) explains the ids and severities. |
| `Verdict:` | The overall decision and its main reason; additional reasons appear on indented lines below it. Findings feed this decision, so matching file counts alone do not guarantee `MATCHES SOURCE`. |

Other checks can print these alternatives or continuation lines:

- **Provenance:** `MISSING`, `INVALID` or `UNSUPPORTED` is followed by any problems,
  separated by semicolons; consult [the provenance fields](json-report.md#provenance).
  These are provenance statuses, separate from the overall verdict.
- **Staged provenance:** `found in the Rekor transparency log; the registry hides it until approval`
  means the provenance was recovered by the staged tarball's digest and verified, rather
  than served by the registry; merely finding a log entry is not enough to certify it.
- **Rebuild:** `not run` means no rebuild result is available (`not run (no source)` when
  there was no source); `FAILED` gives the duration when known and the failure reason.
  A failure can include the image digest and `last output of the … stage:`, followed by
  up to 20 nonblank lines from the last failed or timed-out stage.
- **Named source:** after an `OK` rebuild, `from … as given by --repo/--commit` means you
  chose the reference repository/commit and provenance did not certify that choice.
  The verdict's reason also marks a matching source as named by you.
- **Files without a comparison:** `… in the release; nothing to compare with` counts the
  release entries only; it does not say that they match a rebuild.
- **Finding continuations:** paths and patches are indented under their finding; patches
  run from rebuild to release, so `+` means added in the release. By default the text
  shows at most 10 paths and 40 patch lines per patch, with `… more` or
  `… more lines (see --json)` for the rest; use [the full JSON fields](json-report.md#verdict)
  for the complete paths and attached evidence.

The three verdicts are:

- `MATCHES SOURCE` (exit 0): files match after normalization, with no critical or high
  finding; lower-severity findings may still need attention.
- `DIFFERS FROM SOURCE` (exit 1): once the source, successful rebuild and readable
  comparison are available, a comparison mismatch or a critical/high finding requires
  attention, even if the file counts otherwise match. It does not decide whether a difference was malicious.
- `COULD NOT VERIFY` (exit 2): verification could not finish; it is never **safe**,
  and any findings still need attention. A missing source, failed rebuild or unreadable
  tarball takes priority over critical/high findings and still yields this verdict.

See [docs/rules.md](rules.md#verdict) for the decision rules and
[docs/json-report.md](json-report.md) for every full-length field. The text layout comes
from [`packages/core/src/report/text.ts`](../packages/core/src/report/text.ts).

---

## Why do I get `COULD NOT VERIFY` for a package without provenance, and what do `--repo` and `--commit` change?

`COULD NOT VERIFY` means releaseproof could not finish the check, so it gives no verdict
either way. For a package **without provenance** there is no signed certificate saying which
repository and commit the published tarball came from, so there is nothing to rebuild from.
You can supply the source yourself:

- `--repo <url>` names the repository you expect, for example
  `https://github.com/tj/commander.js`. Only GitHub repositories are supported.
- `--commit <sha>` names the commit to rebuild from. It needs `--repo` and must be the full
  40-character SHA. The manifest's `gitHead` field, when the publisher set one, is a good
  place to find it.

```bash
npx releaseproof check commander@15.0.0 --repo https://github.com/tj/commander.js --commit <sha>
```

With both, releaseproof rebuilds from **the source you named** and compares. A match is
reported as MATCHES SOURCE "(named by you, not certified by provenance)": the tarball is
byte-identical to a clean build of that commit, but no signed statement says the publisher
actually released from it. You chose the reference point.

When the package **does** have verified provenance, the certified commit is always used.
`--repo` then acts only as an expectation: if the provenance names a different repository,
that is a critical finding. `--commit` is ignored in that case. `--repo` alone, with no
provenance and no `--commit`, still ends in `COULD NOT VERIFY`.

---

## Why is Docker required, and what exactly runs inside the containers?

The rebuild has to run the project's own install and build steps, which means running code
from the repository and its dependencies. releaseproof never does that on your machine. Every
step runs in a throwaway container, and the containers drop all Linux capabilities, run as a
non-root user, cannot gain privileges, have memory and process limits, and get no secrets
or credentials from the host.

The rebuild is split into stages that share one Docker volume:

1. **Clone**, with network: the certified (or named) commit is fetched from GitHub.
2. **Install**, with network: dependencies come from the lockfile, with lifecycle scripts
   ignored (`--ignore-scripts`, frozen lockfile).
3. **Build**, without network (`--network none`): dependency install scripts run here, offline,
   then the package's build script, then the project's own package manager packs the tarball.
4. **Export**, without network and with the volume read-only: the tarball is copied out and
   its digest checked.

Keeping the build offline means a malicious build step cannot fetch extra code or send
anything out. The design and the reasons behind each choice are in
[docs/design-rebuild.md](design-rebuild.md).

---

## Why is "could not verify" never "safe"?

`COULD NOT VERIFY` means releaseproof was **unable to complete the verification**, not that
the release is fine. The tool fails closed: if the rebuild fails, if provenance cannot be
checked, if the package manager is not supported, or if any other precondition for a
deterministic verdict is missing, the result is `COULD NOT VERIFY` rather than a green check.

The exit codes reflect this: `0` matches source, `1` differs from source, `2` could not
verify or tool error. Findings that need attention are listed even when the verdict is
`COULD NOT VERIFY`. Treating it as "safe" would undo the purpose of the tool. For the full
rule set and severity levels, see [docs/rules.md](rules.md).

---

## How do I check a staged version (`--stage`, token requirements)?

npm does not expose the attestations of a staged version until it is approved, but it has
already written the provenance to the public Rekor transparency log. releaseproof looks the
staged tarball up there by its SHA-512 and verifies what it finds exactly like a registry
attestation. Pass the repository and, as a fallback, the commit:

```bash
npx releaseproof check --stage <stage-id> --repo https://github.com/<owner>/<repo> --commit <sha>
```

- With a verified Rekor entry built from `--repo`, the source is certified by provenance and
  `--commit` is not used. The report says the provenance was found in Rekor.
- Otherwise (no entry, an entry from another repository, or one that does not verify; anyone
  can write to Rekor, so such entries are only notes) the check rebuilds from `--commit`, and
  the verdict says the source was "named by you, not certified by provenance".
- The lookup sends the tarball's SHA-512 to `rekor.sigstore.dev`. `--no-rekor` turns it off.

- The stage id is the UUID printed by `npm stage publish` and listed by `npm stage list <package>`.
- You may add `<name>@<version>` as the package argument; releaseproof then checks that the
  staged item really is that package and version.
- Downloading a staged tarball needs a registry token. releaseproof uses, in this order,
  `--token`, the `NPM_TOKEN` or `NODE_AUTH_TOKEN` environment variable, then the project and
  user `.npmrc` that `npm login` writes. A granular access token limited to the package with
  "Read and write (stage only)" is enough. Prefer the environment variable or `.npmrc` over
  `--token`, which ends up in your shell history.
- In the GitHub Action, use the `stage` input and pass the token as `NPM_TOKEN` in the step's
  `env`. The trusted-publishing (OIDC) token of a release job cannot download staged items.

---

## Does `--offline` disable all network access?

No. `--offline` only tells Sigstore to prefer its cached trust root over refreshing it, and
even that falls back to the network when there is no usable cache (see the table). It does
not make a check air-gapped, disable the rebuild's networked stages or skip Rekor.

| Endpoint / stage | What can be contacted | Flag controlling it |
| --- | --- | --- |
| Sigstore trust root | `tuf-repo-cdn.sigstore.dev`, the default Sigstore TUF mirror | `--offline` uses the cached trust root when it is present and still valid. On a first run (no cache), or with an expired or corrupt cache, Sigstore contacts the mirror anyway. |
| Release registry | `registry.npmjs.org` by default, or the host chosen with `--registry`, for metadata, tarballs, attestations and signing keys; redirects may contact a CDN | No flag disables these requests. `--registry` changes the registry, not whether it is contacted. |
| Source clone | `github.com` for the source commit; submodules may name additional hosts | No flag disables the clone when there is a source to rebuild. |
| Docker image pulls | The image's registry (Docker Hub for the default `node:<major>-bookworm` image), including its authentication and download hosts | No flag disables image pulls. `--image` selects an image, not an offline mode. |
| Dependency install | Registries and other dependency URLs in the project's configuration / lockfile; Corepack also downloads the package manager version the project pins (pnpm, Yarn, or npm when `packageManager` names npm) | No flag disables network for the install stage. It is skipped only when the build planner finds it unnecessary. |
| Staged provenance lookup | `rekor.sigstore.dev`, sent the tarball's SHA-512 when staged provenance is missing and `--repo` is supplied | `--no-rekor` skips this lookup; `--offline` does not. |

The exact host list depends on the registry, image, repository and lockfile, including their
redirects; this is not a fixed firewall allowlist. The **build and export stages** already run
with `--network none`, regardless of `--offline`; clone and install have network access. See
[the rebuild design](design-rebuild.md) and [staged-version checks](#how-do-i-check-a-staged-version---stage-token-requirements).

---

## How do I use a private registry (`--registry`, `NPM_TOKEN`)?

Pass the registry's base URL with `--registry`, and a token the same way as for staged
versions (`--token`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` or `.npmrc`):

```bash
NPM_TOKEN=<token> npx releaseproof check @myorg/pkg@1.2.3 --registry https://npm.example.com/
```

Tokens in `.npmrc` are matched by registry host and path (`//npm.example.com/:_authToken=...`).
Tokens require HTTPS except on `localhost`, `127.0.0.1` or `::1`; HTTP requests without a token remain allowed.
The `registry=` and `@scope:registry=` lines of `.npmrc` are not read yet, so `--registry` is
needed every time (tracked in #9 and #33).

---

## How do I reproduce a past check with the same Docker image?

The default image is a moving tag such as `node:22-bookworm`. A later pull of that tag can resolve to a different image, so it may not reproduce an earlier rebuild exactly.

Use the full image digest recorded by the earlier check. In the JSON report, copy `rebuild.imageDigest` (for example, `node@sha256:<64-hex-digest>`) and pass that value to `--image`:

```sh
npx releaseproof check sigstore@5.0.0 --image 'node@sha256:<64-hex-digest>'
```

The text report shortens the digest for display. Use `--json` and read `rebuild.imageDigest` when you need the full value. The report's `rebuild.image` shows the image reference used for the check; `rebuild.imageDigest` records the resolved image digest when Docker provides it.

The GitHub Action accepts the same reference through its `image` input:

```yaml
- uses: ujjwalv01/releaseproof@v0.2.2
  with:
    image: node@sha256:<64-hex-digest>
```

Digest references such as `node@sha256:<64-hex-digest>` are accepted by the image-reference validation before Docker is called. The validator covers common Docker image-reference forms; it is not a complete OCI reference parser.

Pinning the image reproduces the image used for the rebuild. Keep the package version and source commit the same as the original check as well.

---

## Why did the rebuild take ten minutes, and when is the install stage skipped?

Most of the time usually goes to the **install** stage, which downloads all dependencies
including dev dependencies. The first run also pulls the `node:<major>-bookworm` image.

The default stage timeouts are **10 minutes for clone, 20 minutes for install and 30 minutes
for build**; a timeout ends in `COULD NOT VERIFY`, and the report names the timed-out stage
and shows the tail of its log when output is available.

The install stage is skipped for npm packages that need no `node_modules` to be packed: no
build script, no `publishConfig.directory`, and no script that runs during `npm pack`
(`prepack`, `prepare`, `prepublishOnly` and similar). Such packages typically finish in well
under a minute. pnpm and Yarn projects always run the install stage, because that is where
Corepack fetches the package manager for the offline build stage.

Large builds can also run out of memory. The containers get 4 GB by default; raise it with
`--memory 8g`, and make sure Docker itself has that much (on Docker Desktop, the VM's memory
setting). An out-of-memory build ends in `COULD NOT VERIFY`, never in a verdict.

---

## The verdict says DIFFERS but the diff looks harmless. What should I do?

`DIFFERS FROM SOURCE` means the published bytes are not what a clean build of the source
produces, or that a critical or high finding fired. releaseproof does not judge intent; a
difference is a difference until someone explains it.

1. Read the findings. Each one names the file and the rule; [docs/rules.md](rules.md) says
   why the rule exists. For changed text files the report shows a diff from the rebuild to the
   release, so lines the release added read as `+`. The text output shortens long patches;
   `--json` has everything.
2. Find the cause. A timestamp or a machine-specific path embedded by the build tool, a
   dependency that resolved differently, or a release built from a different commit are
   common harmless reasons. An added file, a new install script or a changed entry point are
   not, and need an explanation from whoever published.
3. If you believe the build is reproducible and releaseproof is wrong, open an issue with the
   command you ran, the package and version, and the `--json` report, so the cause can be
   handled in the rebuild instead of ignored.

If you think you found a way to make releaseproof report MATCHES SOURCE for a tampered
package, do not open a public issue; follow [SECURITY.md](../SECURITY.md).

---

## Which package managers and repository layouts are supported today?

- **npm**, with or without a lockfile, including npm workspaces.
- **pnpm**, including workspaces and catalogs.
- **Yarn**, classic and Berry. The planner supports both, but no real Yarn project has been
  rebuilt end to end yet (tracked in #16).
- **Lerna** monorepos, also without npm workspaces.

The package manager comes from the `packageManager` field or the lockfile and is run through
Corepack. Anything else, such as bun (tracked in #15), ends in `COULD NOT VERIFY` with a
message naming the unsupported manager.

Only GitHub repositories can be rebuilt. The Node.js major is taken from the release
workflow's `node-version`, then `.nvmrc`, `.node-version`, `.tool-versions` and
`engines.node`, defaulting to 22; override it with `--node`. Real packages that were checked,
and their results, are listed in [docs/real-world-results.md](real-world-results.md).

---

## How do I clean up the images and volumes releaseproof created?

releaseproof normally removes its rebuild volume when the run finishes, including after a
failed stage. `--keep-volume` deliberately keeps it for debugging, and an interrupted run
or failed cleanup can leave it behind. Volumes are named `releaseproof-<hex>` and contain
the checkout, dependencies and build output. List candidates first:

```sh
docker volume ls --filter name=releaseproof-
```

The name filter matches substrings, so review the results. Only remove a volume after its
run has finished and you no longer need its debugging contents; removal deletes that data.
Replace this example with the exact `releaseproof-<hex>` name you selected:

```sh
docker volume rm releaseproof-0123456789ab
```

Docker refuses to [remove a volume still used by a container](https://docs.docker.com/reference/cli/docker/volume/rm/).
Do not force removal or clean up a volume belonging to a running check.

Images remain cached between runs. Init and clone use `node:22-bookworm`; later stages use
`node:<major>-bookworm` for the detected or selected Node.js major, also defaulting to 22.
List the local Node images, then remove only a tag you no longer need:

```sh
docker image ls node
docker image rm node:22-bookworm
```

Choose the actual major you used; if you supplied `--image`, review that image separately.
These images may be shared with other projects. [Removing a tag](https://docs.docker.com/reference/cli/docker/image/rm/)
does not necessarily remove shared image data or reclaim all its displayed size. Do not
force removal of an image in use. The next check that needs a removed image downloads it
again.
