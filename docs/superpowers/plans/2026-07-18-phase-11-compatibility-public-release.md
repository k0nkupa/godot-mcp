# Phase 11 compatibility and public-release implementation plan

**Goal:** Produce auditable compatibility evidence and one verified release set, then publish that exact set through protected channels.

1. Add a strict compatibility matrix and receipt verifier. Keep unexecuted cells pending.
2. Add manifest-verified transactional addon upgrade and lifecycle tests for install, upgrade, rollback, and uninstall.
3. Build deterministic addon/npm artifacts, checksums, SBOM, and one canonical release manifest; independently verify the output.
4. Add the addon-local README/LICENSE required for distribution and validate package contents and version synchronization.
5. Add cross-platform compatibility and protected release workflows. Trusted publication is tag-, environment-, and OIDC-gated.
6. Add the Phase 11 gate: exact local cell, builds, lint/typecheck/tests, hostile/concurrency regressions, lifecycle, artifact reproducibility/integrity, cleanup, and clean Git state.
7. Review the implementation and run the authoritative gate. Report environmental or publication blockers without treating them as passes.
