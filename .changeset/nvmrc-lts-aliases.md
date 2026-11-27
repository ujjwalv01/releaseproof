---
"releaseproof": patch
---

Handle Node.js aliases (`lts/*`, `latest`, `current`, `node`) and older LTS codenames (`lts/gallium`, `lts/fermium`) in `.nvmrc` and `.node-version`, and add a build plan warning when a version file cannot be parsed.
