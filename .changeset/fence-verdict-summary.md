---
"releaseproof": patch
---

Action job summaries and issues now show the verdict summary inside a code block, so archive
entry paths or provenance text it quotes can no longer render as links, mentions or images.
The package name in the heading and the issue title is shown only when it is a valid npm name
and version; a malformed one from the registry is replaced by a note.
