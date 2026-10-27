# Spike: npm staged tarballs and provenance

Phase 1 research. Date: 2026-10-17. Status: **complete** (two open questions need a
live experiment with a real npm account, see section 6).

## TL;DR

- **Staged tarball:** `GET {registry}/-/stage/{stage-id}/tarball` with an ordinary registry
  token (`//registry.npmjs.org/:_authToken`). No 2FA. The stage-id is a UUID. The registry
  only tells us a `shasum` (SHA-1) for a staged tarball, so we compute SHA-512 ourselves.
- **Provenance of a published version:** `dist.attestations.url` in the packument points at
  `{registry}/-/npm/v1/attestations/{name}@{version}` (404 when there is none). It returns
  two Sigstore bundles: an npm **publish attestation** (signed with the registry's key) and a
  **SLSA v1 provenance** (signed with a short-lived Fulcio certificate).
- **Which repo/workflow/ref/commit:** both the provenance *predicate* and the Fulcio
  *certificate* name them. The predicate is built from `GITHUB_*` environment variables
  inside the build job, so anyone with code execution in that job can forge it. The
  certificate extensions come from GitHub's OIDC token via Fulcio and cannot be forged by
  the job. **The certificate is the authoritative source; the predicate is a claim we
  cross-check.**
- `sigstore@5` verifies a real bundle in ~130 ms from cache (~4 s on first run while it
  refreshes the TUF trust root from `tuf-repo-cdn.sigstore.dev`). Wrong identity, tampered
  payload and missing registry key are all rejected.

## 1. Questions

1. How do we download a **staged** tarball programmatically, and what auth does it need?
2. How do we read a **published** version's provenance and attestations, and which
   repository, workflow, ref and commit do they name?

## 2. Method

Nothing below is guessed. Each finding comes from one of:

- **npm CLI source** `npm@12.2.0` (`npm pack npm@12.2.0`, read, never executed), in
  particular `lib/commands/stage/*.js`, `lib/utils/verify-signatures.js`,
  `node_modules/libnpmpublish@12.0.1/lib/{publish,provenance}.js` and
  `node_modules/pacote@22.0.0/lib/registry.js`. The local npm (11.12.1) has no `stage`
  command at all; staging shipped in 11.15.0 [S1].
- **Live registry probes** with `curl` and `pacote` against registry.npmjs.org.
- **Experiments** with `sigstore@5.0.0` on the real attestations of `sigstore@5.0.0`
  (positive case, wrong identity, tampered payload, missing key, offline mode).
- **Official docs**: npm docs, GitHub changelog, Fulcio OID spec, SLSA build type spec,
  sigstore-js README.

## 3. Staged packages

### 3.1 Registry API used by `npm stage` (from `lib/commands/stage/*.js`, npm 12.2.0)

| Command | HTTP | Path | 2FA | Notes |
| --- | --- | --- | --- | --- |
| `npm stage publish` | POST | `/-/stage/package/{escapedName}` | No | Same body as `npm publish` (incl. provenance `_attachments`). Response has `stageId`. |
| `npm stage list` | GET | `/-/stage?page=N&perPage=100[&package=name]` | No | Response `{ items, total }`, paginated. |
| `npm stage view` | GET | `/-/stage/{stage-id}` | No | One item (fields below). |
| `npm stage download` | GET | `/-/stage/{stage-id}/tarball` | No | Raw `.tgz` bytes. |
| `npm stage approve` | POST | `/-/stage/{stage-id}/approve` | **Yes** | Wrapped in `otplease` (OTP prompt). |
| `npm stage reject` | DELETE | `/-/stage/{stage-id}` | **Yes** | Permanently deletes the staged record. |

- The stage-id is validated as a UUID before it is put in the URL
  (`lib/utils/validate-uuid.js`, regex `^[0-9a-f]{8}-[0-9a-f]{4}-...$`). We do the same so a
  user-supplied id can never change the request path.
- All requests go through `npm-registry-fetch`, i.e. normal registry auth:
  `//{host}/:_authToken` Bearer token (or basic auth) for the configured `registry`.
- The CLI docs confirm the 2FA table above and say staging works "with any token type";
  short-lived trusted-publishing (OIDC) tokens can only run `npm publish` /
  `npm stage publish`, not the other `stage` subcommands [S2]. So in CI, listing or
  downloading a staged tarball needs a granular access token, not the OIDC token.

### 3.2 What a staged item contains (`lib/utils/key-values.js` `logStageItem`)

`id`, `packageName`, `version`, `tag`, `createdAt`, `actor`, `actorType`, `shasum`,
`status`, plus any extra fields the registry adds (`...rest`, printed as-is).

Consequences:

- Only a **SHA-1** `shasum` is exposed, not a SHA-512 `integrity`. We compute SHA-512 of the
  downloaded bytes ourselves and also compare SHA-1 to `shasum` as a transport check. SHA-1 is
  not collision-resistant, so it is a sanity check, not a security guarantee.
- Whether the registry exposes **attestations for a staged version before approval** is
  not visible in the CLI source (the extra fields are opaque). The staged publish body does
  carry the provenance bundle (same code path as `npm publish`, `libnpmpublish/lib/publish.js`
  lines 61-73 and 181). Open question 6.1.

### 3.3 Policy context (why staging matters for us)

- Staged publishing GA: GitHub changelog, May 22, 2026. Needs npm CLI 11.15.0+. A trusted
  publishing configuration "can be limited to stage-only, which means `npm publish` from
  that workflow will be rejected and only `npm stage publish` is accepted" [S1].
- npm docs: staged publishing needs npm CLI 11.15.0+ and Node 22.14.0+; approval needs 2FA
  in the CLI or on npmjs.com; `npm stage download <stage-id>` is the documented way "to
  download the staged package tarball for inspection" [S3].
- Trusted publishers have an **"Allowed actions"** setting: `npm stage publish` is always
  allowed; `npm publish` and `npm dist-tag` are opt-in. Configurations created after
  Sep 3, 2026 default to stage publish only; those created before May 20, 2026 allow
  `npm publish` only [S4].
- 2FA-bypass granular access tokens: "2FA-bypass tokens will also lose direct publish. We are
  targeting January 2027 for this update." What remains is "reading private packages and
  staging a publish" [S5].

## 4. Provenance of a published version

### 4.1 Where to find it

Every version document (full packument, abbreviated `install-v1` packument, and
`pacote.manifest()` output) has:

```jsonc
"dist": {
  "integrity": "sha512-hJqJ…",                 // base64 SHA-512 of the tarball
  "shasum": "c2ed2b…",
  "tarball": "https://registry.npmjs.org/sigstore/-/sigstore-5.0.0.tgz",
  "signatures": [ { "keyid": "SHA256:DhQ8…", "sig": "MEUC…" } ],   // registry signature
  "attestations": {
    "url": "https://registry.npmjs.org/-/npm/v1/attestations/sigstore@5.0.0",
    "provenance": { "predicateType": "https://slsa.dev/provenance/v1" }
  }
}
```

- Scoped names are URL-encoded in the attestations URL:
  `/-/npm/v1/attestations/@sigstore%2fverify@4.1.2`.
- No attestations → the `dist.attestations` key is absent and the URL returns **404**
  (checked with `lodash@4.17.21`). Unknown version → 404 too.
- pacote fetches the attestations by **path** against the configured registry, never the
  absolute URL from the packument (`registry.js` lines 230-233). We copy that: the packument
  is untrusted data and must not redirect us to another host.
- `gitHead` and `repository` in the packument are **unsigned, maintainer-supplied**. In the
  survey below `gitHead` is missing for 7 of 17 provenance-bearing packages. Use only as a
  labelled hint when there is no provenance.
- `_npmUser.trustedPublisher` (`{ id: "github", oidcConfigId }`) shows trusted publishing
  was used. `prettier@3.9.10` has it but **no attestations**: provenance can be turned off
  (`provenance=false`) and is only generated for public repos/packages [S4]. "Trusted
  publisher but no provenance" is a real case we must handle.

### 4.2 Response shape

`GET /-/npm/v1/attestations/{name}@{version}` → `{ "attestations": [ { predicateType, bundle } ] }`

| # | `predicateType` | Bundle media type | Signed with | Statement |
| --- | --- | --- | --- | --- |
| 1 | `https://github.com/npm/attestation/tree/main/specs/publish/v0.1` | `application/vnd.dev.sigstore.bundle+json;version=0.2` | registry key (`verificationMaterial.publicKey.hint` = keyid) | in-toto v0.1, predicate `{ name, version, registry }` |
| 2 | `https://slsa.dev/provenance/v1` | `application/vnd.dev.sigstore.bundle.v0.3+json` | Fulcio certificate (`verificationMaterial.certificate.rawBytes`) | in-toto v1, SLSA v1 predicate |

Both are DSSE envelopes (`payloadType: application/vnd.in-toto+json`), both have exactly one
subject `pkg:npm/{name}@{version}` with `digest.sha512` = **hex** of the base64
`dist.integrity` (verified equal for `sigstore@5.0.0`), and one Rekor transparency-log
entry (`kind: dsse`). Some bundles also carry an RFC 3161 timestamp (3 of 17 in the survey).

Registry keys: `GET /-/npm/v1/keys` → `{ keys: [ { keyid, keytype, scheme, key, expires } ] }`.
Current key `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` (`expires: null`); the
previous key expired 2025-01-29. npm first tries the same keys as a TUF target
(`registry.npmjs.org/keys.json`) and falls back to this endpoint (`verify-signatures.js`
`setKeys`).

### 4.3 The provenance predicate (what the build job *claims*)

Generated by `libnpmpublish/lib/provenance.js` from environment variables on GitHub Actions:

| Predicate field | Source env var | Example (`sigstore@5.0.0`) |
| --- | --- | --- |
| `buildDefinition.buildType` | constant | `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1` |
| `externalParameters.workflow.repository` | `GITHUB_SERVER_URL/GITHUB_REPOSITORY` | `https://github.com/sigstore/sigstore-js` |
| `externalParameters.workflow.path` | `GITHUB_WORKFLOW_REF` (before `@`) | `.github/workflows/release.yml` |
| `externalParameters.workflow.ref` | `GITHUB_WORKFLOW_REF` (after `@`) | `refs/heads/main` |
| `internalParameters.github.event_name` | `GITHUB_EVENT_NAME` | `push` |
| `internalParameters.github.repository_id` | `GITHUB_REPOSITORY_ID` | `495574555` |
| `internalParameters.github.repository_owner_id` | `GITHUB_REPOSITORY_OWNER_ID` | `71096353` |
| `resolvedDependencies[0].uri` | `git+{server}/{repo}@{GITHUB_REF}` | `git+https://github.com/sigstore/sigstore-js@refs/heads/main` |
| `resolvedDependencies[0].digest.gitCommit` | `GITHUB_SHA` | `7d2900ec…` |
| `runDetails.builder.id` | `https://github.com/actions/runner/{RUNNER_ENVIRONMENT}` | `…/github-hosted` |
| `runDetails.metadata.invocationId` | run URL | `https://github.com/sigstore/sigstore-js/actions/runs/26781866618/attempts/1` |

GitLab produces a different, older shape (in-toto v0.1 + SLSA **v0.2**, `materials[0]`,
`invocation.configSource`). Not seen in the survey; v1 parsing is enough for now and v0.2
is reported as "unsupported provenance format" (fail closed).

SLSA build-type spec notes [S7]: `workflow.ref` is a full `refs/…` ref; `repository` has no
`.git` suffix; `path`/`ref` may contain `@`; `resolvedDependencies[0]` is the source commit
and more entries MAY exist; the build type is only valid for `create`, `release`, `push`
and `workflow_dispatch` events, **not `pull_request`**.

Security point: a step with code execution in the job can run
`GITHUB_SHA=… GITHUB_REPOSITORY=… npm publish`. Child processes see the overridden values,
so **the predicate is forgeable** by the very attacker we worry about.

### 4.4 The Fulcio certificate (what GitHub *attested* via OIDC)

Dumped with `openssl x509 -text`. Validity is 10 minutes (`Jun 1 21:02:50` → `21:12:50 2026`);
the signature is valid because the Rekor entry's `integratedTime` falls inside it. Issuer
`O=sigstore.dev, CN=sigstore-intermediate`, empty Subject, critical SAN URI. Extensions
(Fulcio OID spec [S6]):

| OID `1.3.6.1.4.1.57264.1.*` | Name | Value in sample | Encoding |
| --- | --- | --- | --- |
| SAN (2.5.29.17) | Build Signer URI (the job that signed) | `https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main` | URI |
| .1 – .6 | Issuer, Trigger, SHA, Workflow name, Repository, Ref (**deprecated**) | `https://token.actions.githubusercontent.com`, `push`, `7d29…`, `Release`, `sigstore/sigstore-js`, `refs/heads/main` | raw string |
| .8 | Issuer (v2) | `https://token.actions.githubusercontent.com` | DER UTF8String |
| .9 | Build Signer URI | same as SAN | DER UTF8String |
| .10 | Build Signer Digest | `7d29…` | DER UTF8String |
| .11 | Runner Environment | `github-hosted` | DER UTF8String |
| .12 | **Source Repository URI** | `https://github.com/sigstore/sigstore-js` | DER UTF8String |
| .13 | **Source Repository Digest** (commit) | `7d2900eca1c22b3f87c13987c8d4b7c9a29b733a` | DER UTF8String |
| .14 | **Source Repository Ref** | `refs/heads/main` | DER UTF8String |
| .15 | Source Repository Identifier | `495574555` | DER UTF8String |
| .16 | Source Repository Owner URI | `https://github.com/sigstore` | DER UTF8String |
| .17 | Source Repository Owner Identifier | `71096353` | DER UTF8String |
| .18 | **Build Config URI** (top-level workflow) | `https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main` | DER UTF8String |
| .19 | Build Config Digest | `7d29…` | DER UTF8String |
| .20 | **Build Trigger** | `push` | DER UTF8String |
| .21 | Run Invocation URI | `https://github.com/sigstore/sigstore-js/actions/runs/26781866618/attempts/1` | DER UTF8String |
| .22 | Source Repository Visibility At Signing | `public` | DER UTF8String |
| .23 | Deployment Environment | absent (no GitHub environment used) | DER UTF8String |
| .24 | Token Subject | `repo:sigstore/sigstore-js:ref:refs/heads/main` | DER UTF8String |

- `sigstore.verify()` returns `signer.identity = { subjectAlternativeName, extensions: { issuer },
  oids: [{ oid: { id: number[] }, value: bytes }] }`. The `value` of .8+ is the DER-wrapped
  UTF8String (tag `0x0C`, length, bytes) — we decode it with a 10-line DER reader; .1–.6 are raw.
  Verified against the `openssl` dump for all 22 extensions.
- **Reusable workflows:** the SAN / Build Signer URI (.9) is the *reusable* workflow that
  called `npm publish`, while Build Config URI (.18) is the *top-level* workflow of the
  package repo. In the survey, `tsup@9.0.0` was signed by
  `sxzz/workflows/.github/workflows/release.yml@refs/heads/main` (another repository) while
  the predicate says `egoist/tsup/.github/workflows/release.yml@refs/tags/v9.0.0`; `pacote`
  and `semver` were signed by `release-integration.yml` while the predicate says `release.yml`.
  So: compare the predicate's workflow to **.18**, repo to **.12**, commit to **.13**, ref to
  **.14**, trigger to **.20**, run URL to **.21** — not to the SAN. A signer outside the
  package's own repository is worth reporting on its own.

### 4.5 Survey of 25 popular packages (latest versions, 2026-10-17)

| Package | Provenance | Trigger / ref | Note |
| --- | --- | --- | --- |
| vitest 5.0.5, vite 8.3.4, @biomejs/biome 2.5.15, esbuild 0.28.2, tsx 4.23.15, @tanstack/query-core 5.104.3 | v1 | `push` / `refs/heads/main` or `master` | |
| tsup 9.0.0, next 16.4.2, axios 1.20.0 | v1 | `push` / `refs/tags/vX.Y.Z` | tsup signed by a reusable workflow in `sxzz/workflows` |
| express 5.3.0 | v1 | `release` / `refs/tags/v5.3.0` | |
| react 19.3.1, zod 4.6.7, @actions/core 3.0.1 | v1 | `workflow_dispatch` / branch | react: `refs/heads/releases/19.3.x` |
| pacote 22.0.0, semver 7.8.5 | v1 | `push` / main | signed by `release-integration.yml` (reusable, same repo) |
| prettier 3.9.10 | **none** | | trusted publisher, provenance disabled |
| typescript 7.0.2, commander 15.0.0, execa 10.1.1, eslint 10.13.0, tar 7.5.22, diff 9.0.0, lodash 4.18.1, chalk 6.0.1, @types/node 26.6.5 | **none** | | |

17/25 have provenance; all 17 are SLSA v1 + bundle v0.3 + in-toto v1 with one subject and
both attestation kinds. All builders are `https://github.com/actions/runner/github-hosted`.

### 4.6 Verifying with `sigstore@5.0.0` (experiments)

API: `verify(bundle, options?) → Promise<Signer>` (no `data` argument needed for DSSE).
Default checks: certificate chain against the Sigstore trust root (TUF), ≥1 SCT
(`ctLogThreshold: 1`), ≥1 transparency-log entry (`tlogThreshold: 1`), signature over the
DSSE payload, certificate validity at the log's integrated time [S8].

| Experiment | Result |
| --- | --- |
| verify provenance, default options | OK, **4.16 s** (TUF refresh from `https://tuf-repo-cdn.sigstore.dev`) |
| same, `tufForceCache: true` + identity policy | OK, **126 ms** (fully offline) |
| wrong `certificateIdentityURI` | rejected: `certificate identity error - expected …evil/evil… got …sigstore/sigstore-js…` |
| `gitCommit` edited in the payload | rejected: `DSSE payload hash mismatch` |
| publish attestation with registry key via `keySelector` | OK |
| publish attestation without a key | rejected: `key not found: SHA256:DhQ8…` |

Details that shape the design:

- **TUF cache** default: `%LOCALAPPDATA%\sigstore-js` (Windows), `~/.local/share/sigstore-js`
  (Linux, `XDG_DATA_HOME`), `~/Library/Application Support/sigstore-js` (macOS). Options:
  `tufCachePath`, `tufMirrorURL`, `tufForceCache`. Network to the Sigstore CDN is a trust-root
  refresh, not telemetry; nothing about the package leaves the machine.
- **Identity policy is a regex.** `@sigstore/verify` does `signerIdentity.match(policyIdentity)`
  with the string you pass, unanchored and with `.` as a wildcard. We never pass
  `certificateIdentityURI` as a string; we compare `signer.identity` fields exactly ourselves.
- **pacote's `verifyAttestations: true`** (what `npm audit signatures` uses) checks: subject
  name equals the purl, subject sha512 equals the tarball integrity, a registry key exists for
  keyed attestations, then `sigstore.verify`. It does **not** check the certificate identity,
  nor cross-check predicate vs certificate. That is the gap releaseproof fills.
- Only `@sigstore/verify` exports the `Signer` type; `sigstore` itself does not re-export it.
  Use `Awaited<ReturnType<typeof verify>>` to avoid an extra dependency.

## 5. Decisions for implementation

| # | Decision | Why |
| --- | --- | --- |
| D1 | Fetch attestations by **path** against the configured registry, never the absolute URL in the packument. | The packument is untrusted; same as pacote. |
| D2 | Call `sigstore.verify` ourselves (plus pacote for manifest/tarball), not pacote's `verifyAttestations`. | We need the `Signer` identity and the decoded predicate for reporting and cross-checks. |
| D3 | Do our own subject checks: exactly one subject, `name === pkg:npm/{name}@{version}`, `sha512 === hex(integrity)`. | Copies pacote/libnpmpublish; fail closed on anything else. |
| D4 | Treat the **certificate** (.12/.13/.14/.18/.20/.21, issuer .8, SAN) as authoritative; parse the predicate as a claim; report every mismatch as a finding. | Predicate comes from forgeable env vars; certificate comes from the OIDC token. |
| D5 | Compare the predicate workflow to Build Config URI (.18), not to the SAN. Report a signer outside the package repository separately. | Reusable workflows (tsup, pacote, semver) are legitimate and common. |
| D6 | Never use `certificateIdentityURI` / `certificateIssuer` string options; compare exact strings on the returned identity. | The policy is an unanchored regex. |
| D7 | `issuer` must be exactly `https://token.actions.githubusercontent.com`; builder must start with `https://github.com/actions/runner/`. Other issuers/builders → "unsupported provenance" (could not verify), not "safe". | v1 only supports GitHub Actions; fail closed. |
| D8 | Provenance result has three states: `verified`, `missing`, `invalid`. `missing` is not an error for the tool (rebuild can still run with `--repo`/`--commit`), but the verdict can never be "MATCHES SOURCE" without a verified source. | Fail closed. |
| D9 | Verify the registry publish attestation too, with keys from `GET /-/npm/v1/keys`. Missing key for a keyed attestation → `invalid`. (npm also tries the TUF target `registry.npmjs.org/keys.json` first; that needs `@sigstore/tuf` directly and is deferred.) | Cheap; catches a mirror/MITM serving a different tarball. |
| D10 | Staged: validate the stage-id as UUID before building the URL; compute SHA-512 of the bytes; check SHA-1 against `shasum`. | Same guard as npm; no `integrity` is available for staged tarballs. |
| D11 | Expose `tufCachePath`/`tufForceCache` as options (`--offline` later); default allows the TUF refresh. | Determinism vs. freshness of the trust root; the refresh is needed for correct verification. |
| D12 | SLSA v0.2 / GitLab provenance → `unsupported` (reported as could-not-verify) in v1. | Not seen on npm for GitHub Actions; avoid half-support. |

## 6. Open questions — answered by a live experiment (2026-10-18)

`.github/workflows/stage-experiment.yml` staged `@ujjwalv01/releaseproof-stage-test@0.0.1`
from GitHub Actions with `npm stage publish --access public --provenance --json` (npm 12,
a granular access token), inspected it, and the staged item was then rejected by hand.

1. **Attestations for a staged version are not exposed before approval.**
   `GET /-/npm/v1/attestations/{name}@{version}` is 404 with and without the token, and the
   package has no packument yet (404). Yet npm *did* generate the provenance at stage time:
   "Provenance statement published to transparency log: logIndex=3309737268". The
   attestation exists in Rekor; only the registry's endpoint hides it until approval.
   Consequence: staged checks run without provenance and say so (`--repo`/`--commit` name
   the source). Follow-up, implemented in `packages/core/src/provenance/rekor.ts`: the
   staged tarball is looked up in Rekor by its SHA-512 (the search index holds the subject
   digests of in-toto statements). npm writes `dsse` v0.0.1 entries, which store the
   certificate, the signature and the SHA-256 of the statement but not the statement, so
   releaseproof rebuilds npm's statement from the certificate (every field in it comes
   from a GitHub variable that Fulcio also certifies) and uses it only when its hash is the
   signed one. The result is turned into a Sigstore bundle and verified like a registry
   attestation; only an entry built from the expected repository counts.
2. **A "Read and write (stage only)" granular token is enough** for `npm stage publish`,
   `list`, `view` and `download`. npm's token form now offers that permission explicitly
   and recommends it over direct publish.

Also observed: `npm stage publish --json` prints `stageId`, the sha512 `integrity`, the
`shasum` and the file list; `npm stage list/view` items carry `access` and a `status`
(`validating` right after staging) in addition to the fields in section 3.2; the
`stage download` tarball's SHA-1 and SHA-512 match the values printed at stage time.

## 7. Sources

- [S1] GitHub Changelog, "Staged publishing and new install-time controls for npm", May 22, 2026 —
  <https://github.blog/changelog/2025-05-22-staged-publishing-and-new-install-time-controls-for-npm/>
- [S2] npm CLI docs `npm-stage` (npm 12.2.0, `docs/content/commands/npm-stage.md`): 2FA table, token table,
  "Shortlived tokens cannot run `npm stage` subcommands."
- [S3] npm Docs, "Staged publishing for npm packages" — <https://docs.npmjs.com/staged-publishing>
- [S4] npm Docs, "Trusted publishing for npm packages", section "Configuring allowed actions" —
  <https://docs.npmjs.com/trusted-publishers>
- [S5] GitHub Changelog, "Restricting npm bypass-2FA granular access tokens", July 31, 2026 —
  <https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/>
- [S6] Sigstore Fulcio, "Sigstore OID information" —
  <https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md>
- [S7] SLSA, GitHub Actions `workflow/v1` build type —
  <https://github.com/slsa-framework/github-actions-buildtypes/blob/main/workflow/v1/README.md>
- [S8] sigstore-js client README (`verify` options, thresholds, regex identity) —
  <https://github.com/sigstore/sigstore-js/blob/main/packages/client/README.md>
- [S9] npm CLI source `npm@12.2.0`: `lib/commands/stage/{download,list,view,approve,reject,publish}.js`,
  `lib/utils/validate-uuid.js`, `lib/utils/key-values.js`, `lib/utils/verify-signatures.js`;
  `libnpmpublish@12.0.1/lib/{publish,provenance}.js`; `pacote@22.0.0/lib/registry.js`.
- [S10] Live registry data, 2026-10-17: `GET /-/npm/v1/attestations/sigstore@5.0.0`,
  `GET /-/npm/v1/keys`, `GET /sigstore/5.0.0`, `GET /-/npm/v1/attestations/lodash@4.17.21` (404),
  and the 25-package survey in section 4.5.
