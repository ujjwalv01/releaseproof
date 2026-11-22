---
"releaseproof": patch
---

Flag `.env.*` variants (excluding `.env.example`, `.env.sample` and `.env.template`), nested `.env` and `.npmrc` files, and `id_dsa` / `id_ecdsa` / `id_ed25519` (including `_sk`) SSH private keys in `unexpected-path`.
