# Frequently asked questions

This FAQ covers the questions that come up most often after a first run. For the full rules
and report format, see [docs/rules.md](rules.md) and [docs/json-report.md](json-report.md).

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

## How do I use a private registry (`--registry`, `NPM_TOKEN`)?

Pass the registry's base URL with `--registry`, and a token the same way as for staged
versions (`--token`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` or `.npmrc`):

```bash
NPM_TOKEN=<token> npx releaseproof check @myorg/pkg@1.2.3 --registry https://npm.example.com/
```

Tokens in `.npmrc` are matched by registry host and path (`//npm.example.com/:_authToken=...`).
The `registry=` and `@scope:registry=` lines of `.npmrc` are not read yet, so `--registry` is
needed every time (tracked in #9 and #33).

---

## Why did the rebuild take ten minutes, and when is the install stage skipped?

Most of the time usually goes to the **install** stage, which downloads all dependencies
including dev dependencies. The first run also pulls the `node:<major>-bookworm` image.

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
