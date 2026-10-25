# Frequently Asked Questions

This FAQ covers the questions that come up most often after a first run. For the full rules and report format, see [docs/rules.md](rules.md) and [docs/json-report.md](json-report.md).

---

## Why do I get `COULD NOT VERIFY` for a package without provenance, and what do `--repo` and `--commit` change?

`COULD NOT VERIFY` means releaseproof cannot make a safe determination. For a package **without provenance**, there is no signed certificate telling releaseproof which repository and commit the published tarball came from. In that situation you must supply the source yourself:

- `--repo <repository>` declares the repository you expect the package to come from.
- `--commit <commit>` tells releaseproof which commit to rebuild from when provenance is absent.

When you pass both, releaseproof rebuilds from **the source you named**. The verdict reflects whether the published tarball matches *your* source, but it does **not** prove that the publisher was certified to release from that source. That is what “named by you, not certified by provenance” means: you provided the reference point, but no trusted third party attested that this reference point is the one the publisher actually used. See [docs/design-rebuild.md](design-rebuild.md) for the rebuild flow.

---

## Why is Docker required, and what exactly runs inside the containers?

Docker is required because releaseproof performs the rebuild in a **clean, hardened container** so that the build environment is isolated from your local machine and from other builds. Without this isolation, differences between your local toolchain and the publisher's toolchain could produce misleading diffs.

Inside the container, releaseproof:

1. **Clones** the certified (or user-supplied) commit.
2. **Installs** dependencies **with network access, but with lifecycle scripts ignored**.
3. **Builds** the package **without network access**.
4. **Packs** the result into a tarball for comparison.

This sequence is the security boundary. Network isolation during build prevents a malicious package from fetching additional code at build time, while the install stage is kept network-enabled so normal dependency resolution can work. The exact container image and build plan are described in [docs/design-rebuild.md](design-rebuild.md).

---

## Why is “could not verify” never “safe”?

`COULD NOT VERIFY` means releaseproof was **unable to complete the verification**, not that the release is fine. The tool fails closed: if the rebuild fails, if provenance cannot be checked, if an unsupported package manager is used, or if any other precondition for a deterministic verdict is missing, the result is `COULD NOT VERIFY` rather than a green check.

The exit codes reflect this: `0` = matches source, `1` = differs from source, `2` = could not verify (or tool error). Treating `COULD NOT VERIFY` as “safe” would invert the entire purpose of the tool. For the full rule set and severity levels, see [docs/rules.md](rules.md).

---

## How do I check a staged version (`--stage`, token requirements)?

A staged version has not yet been approved and **does not carry provenance**. To check one, use:

```bash
npx releaseproof check --stage <stage-id> --repo <repo> --commit <commit>