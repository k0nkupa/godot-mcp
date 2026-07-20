# Compatibility receipts

A certified matrix cell points to one JSON receipt in this directory. Receipts are accepted only when they record:

- schema version 1 and `result: "passed"`;
- the exact Godot, platform, architecture, and gate identity from the matrix;
- the tested Git commit and a GitHub Actions run URL;
- all 15 Phase 11 stages with `status: "passed"`;
- a completion timestamp.

The release preflight verifies that the tested commit is an ancestor and that later changes are limited to the matrix and receipt records. Never hand-author a passing receipt for an unexecuted or skipped cell.
