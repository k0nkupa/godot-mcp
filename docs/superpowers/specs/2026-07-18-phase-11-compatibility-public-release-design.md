# Phase 11 compatibility and public-release design

## Decision

Phase 11 is evidence-driven: a Godot/platform pair is advertised only after that exact cell passes the release gate. The current 4.7/macOS implementation remains the sole candidate cell until CI produces complete receipts; 4.4–4.6, Linux, and Windows begin as pending and do not widen the runtime handshake.

One canonical release manifest binds the product version, source revision, compatibility evidence, addon archive, npm tarballs, checksums, and SBOM. Publication refuses a dirty checkout, a non-tagged revision, missing repository/package identity, pending advertised cells, or mismatched artifacts.

## Compatibility contract

- `release/compatibility-matrix.json` is the source of truth.
- Every cell names an exact engine version, platform, architecture, state, and required gate.
- `certified` requires a receipt with the same cell identity, source revision, gate name, timestamp, and successful stage list.
- `pending` is never represented as supported in package or addon metadata.
- Adding older Godot versions must not weaken protocol, project-identity, containment, audit, or cleanup controls.

## Release contract

`scripts/build-release.mjs` creates a fresh output directory and emits:

- deterministic `godot-mcp-addon-<version>.zip`;
- npm-compatible tarballs from staged, rewritten workspace packages;
- CycloneDX-style component inventory and SHA-256 checksums;
- `release-manifest.json`, generated last, covering every artifact.

The builder never publishes. `scripts/verify-release.mjs` independently recomputes every digest and validates version synchronization. The GitHub release workflow runs the full Phase 11 gate, builds and verifies once, attests the artifacts, publishes npm through OIDC trusted publishing, and uploads the same files to the GitHub release. Godot Asset Library submission remains a manual, reviewed step using the exact attested addon archive and release manifest.

## Lifecycle and rollback

Upgrade uses the same manifest-verified ownership boundary as uninstall. It refuses modified or untracked installed files, stages the replacement before switching, preserves the original project/config preimages, and restores the prior tree and manifest if the switch fails. Rollback is the same operation pointed at the previously released addon source. Tests independently prove install, upgrade, rollback, and uninstall on disposable projects.

## Publication boundary

No local command in this phase changes npm, GitHub, or Asset Library state. Public release requires a clean tagged GitHub checkout, configured repository/package ownership, protected release environment approval, OIDC, successful matrix receipts, immutable commit pins for every release-workflow action, and human Asset Library review.
