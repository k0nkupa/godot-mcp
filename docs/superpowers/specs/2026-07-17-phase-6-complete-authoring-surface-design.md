# Phase 6 Complete Authoring Surface Design

**Status:** Approved for implementation planning on 2026-07-17

**Baseline:** `main` at `93f1c84`, with Phase 0–5 implemented

**Engine target:** Godot `4.7.stable.official.5b4e0cb0f`

## 1. Purpose

Phase 6 expands the permission-scoped `godot_editor` surface from bounded scene and resource mutation into a complete normal-profile authoring surface. It adds constrained GDScript and shader source workflows, resource property authoring, typed operations for complex stable Godot domains, and introspection-driven operations for the remaining supported domains.

The phase preserves the Phase 5 transaction model. Authoring requests are previewed, revision-bound, idempotent, Undo/Redo-backed, audited, and recoverable. Phase 6 does not add a second MCP authoring tool and does not weaken the authenticated bridge, project identity, path, capability, or rollback boundaries.

## 2. Scope

Phase 6 supports authoring for:

- project-local `.gd` scripts and `.gdshader` shaders through constrained create and replace operations;
- stored properties on project resources and embedded resources;
- Control layout and theme items;
- Animation libraries, animations, tracks, keys, and AnimationTree resources;
- audio stream references and audio-node configuration;
- physics shapes and physics-node configuration;
- navigation meshes, regions, links, agents, and navigation-node configuration;
- TileMapLayer sources, layers, and bounded cell edits;
- particle process materials and particle-node configuration;
- materials, meshes, textures, and their references;
- registered custom Resource classes that pass the explicit editor class-registry checks; and
- references to already indexed imported assets, plus validation of caller-supplied import-setting expectations.

The domain list is delivered through a combination of typed composite operations and introspection-driven property operations. Typed operations are used when the domain has invariants that cannot be expressed safely as independent property writes. Introspection is used when Godot already exposes a stable stored-property contract and an additional public operation would only duplicate it.

## 3. Explicit exclusions

Phase 6 does not expose:

- script or shader execution, evaluation, expression evaluation, arbitrary method calls, or arbitrary engine calls;
- arbitrary project-file or host-filesystem reads and writes;
- C#, C++, GDExtension, binary resource, binary scene, or native plugin authoring;
- automatic import scans, reimports, importer execution, plugin state, project settings, builds, exports, or artifact management;
- arbitrary network access, shell commands, caller-selected executables, or caller-selected host paths;
- unsafe fixture execution or a claim that project scripts are sandboxed; or
- source-file move or delete operations. Reference-aware source relocation can be designed separately if a later phase needs it.

Import and reimport execution remain Phase 9 `project_operate + project` operations. Phase 6 may author references to assets already indexed by `EditorFileSystem` and validate expected importer names/options, but it must not call scan or reimport APIs.

## 4. Public tool and permission model

Phase 6 extends the existing `godot_editor` tool. It remains visible only when the session grants both:

- permission tier `project_mutate`; and
- capability pack `editor`.

The default session continues to expose exactly six observe-only tools. Phase 6 adds no new visible MCP tool, permission tier, or capability pack.

All Phase 6 authoring steps use the existing top-level operations:

- `preview` for a side-effect-free plan and plan digest;
- `apply` with a UUID idempotency key and expected plan digest;
- `undo` with an action identifier and UUID idempotency key; and
- `redo` with an action identifier and UUID idempotency key.

Existing Phase 5 clients and requests remain valid without changes.

## 5. Authoring operation model

### 5.1 Introspection-driven property authoring

Phase 6 adds resource-targeted equivalents of the existing node property workflow:

- `set_resource_property` targets one stored property on a project or embedded Resource;
- `set_resource_metadata` and `remove_resource_metadata` manage bounded, non-secret metadata; and
- `assign_resource_reference` assigns a validated project or embedded resource reference to a compatible node or resource property.

The editor adapter resolves the target through a canonical `res://` path, ResourceUID where available, and an optional embedded-resource locator. It reads the real Godot property list and accepts only properties that:

- are present on the resolved object;
- have `PROPERTY_USAGE_STORAGE`;
- are not editor-internal, read-only, secret-shaped, script-bearing, or explicitly denied;
- have a Variant type and class hint compatible with the supplied value; and
- can be encoded into a deterministic, bounded preimage and receipt.

The value schema expands the Phase 5 tagged Variant model with the Godot value types required by the supported domains, including integer vectors, rectangles, transforms, quaternions, planes, AABBs, StringName values, packed primitive arrays, typed resource references, and bounded dictionaries and arrays. Object IDs, Callables, Signals, RIDs, encoded objects, raw Script objects, and unknown tags remain forbidden.

### 5.2 Typed composite operations

Phase 6 exposes typed composite steps only for stable operations with cross-property or ordered-collection invariants:

- `configure_control_layout` for anchors, offsets, grow directions, minimum size, and size flags;
- `set_theme_item` and `remove_theme_item` for typed theme colors, constants, fonts, font sizes, icons, and styleboxes;
- `upsert_animation`, `remove_animation`, `upsert_animation_track`, `remove_animation_track`, `upsert_animation_key`, and `remove_animation_key`;
- `configure_animation_tree` for an AnimationTree root, active state, process callback, and validated parameter paths;
- `set_tile_cells` and `erase_tile_cells` for a bounded set of TileMapLayer coordinates and source/atlas alternatives; and
- `create_custom_resource` for an explicitly registered Resource class whose script identity and declared exported properties are present in the editor filesystem registry.

Audio, physics, navigation, particles, materials, meshes, textures, and most UI node configuration use strict introspection-driven stored-property operations plus typed resource references. This avoids duplicating Godot's property model while retaining compatibility checks. Focused fixture tests define and certify the supported property paths for each advertised domain.

Typed composite operations expand inside Godot into the same prepared transaction-step representation as ordinary mutations. Expansion does not bypass path checks, preconditions, history selection, size limits, audit normalization, or rollback.

`create_custom_resource` does not instantiate the project class during preview or apply. It emits deterministic textual `.tres` content containing the registered script UID/reference and values limited to the class registry's exported stored properties, then validates the text structure and reference graph. The trusted disposable fixture may load the resulting resource for its behavior assertion; normal-profile authoring does not deliberately invoke the custom class constructor.

### 5.3 Script and shader source workflows

Phase 6 adds four source steps:

- `create_script` for a new canonical `.gd` file;
- `replace_script` for an existing canonical `.gd` file with an expected SHA-256 preimage;
- `create_shader` for a new canonical `.gdshader` file; and
- `replace_shader` for an existing canonical `.gdshader` file with an expected SHA-256 preimage.

Source content must be valid UTF-8, contain no NUL byte, use normalized LF line endings, and be no larger than 192 KiB per file. The complete request remains subject to the 256 KiB serialized request limit. Paths must be canonical project-local `res://` paths and must not resolve into addons, `.godot`, hidden control directories, credentials, generated code, imported caches, symlinks, or post-validation substitutions.

Preview parses source in memory without saving or executing it. GDScript validation compiles source through a fresh Script resource without instantiating it or calling project code. Shader validation parses source through a fresh Shader resource without assigning it to a live material. Parse diagnostics are normalized into bounded line, column, severity, and message records without raw host paths or stack traces.

Apply rechecks the expected absence or content hash, writes through the existing same-directory atomic file transaction, asks the editor filesystem to observe the changed source without invoking project import/reimport commands, and verifies that the indexed source reports no parse failure. If post-write verification fails, the transaction restores the exact preimage and reports rollback outcome.

Phase 6 source authoring is not described as safe execution. It limits where and how source is written and validates syntax without deliberately running the authored source.

### 5.4 Imported assets and import settings

Resource references to textures, meshes, audio streams, fonts, and other imported assets must resolve to an entry already indexed by `EditorFileSystem`. Preview records the asset path, UID, resource type, importer name, import-valid state, and the hash of the relevant observed import metadata.

Requests may include expected importer and expected option values as preconditions. Phase 6 validates those expectations against editor metadata so authoring can depend on known import configuration. It does not mutate `.import` files, call `scan`, call `scan_sources`, call `reimport_files`, or otherwise trigger importer execution. Import-option mutation and reimport remain coupled Phase 9 operations because the editor can automatically turn import-setting writes into importer execution.

## 6. Architecture and component boundaries

The request path remains:

```text
MCP stdio
  -> strict Phase 6 authoring schema
  -> project_mutate + editor authorization
  -> mutation ledger and audit normalization
  -> authenticated loopback bridge
  -> editor main-thread queue
  -> authoring planner and focused domain adapter
  -> native Undo/Redo and atomic project-file transaction
  -> save/reload/reference verification
  -> structured result and audit receipt
```

The implementation uses focused components rather than extending the existing editor mutation adapter into one large domain file:

- protocol authoring schemas define resource locators, extended variants, source operations, and typed composites;
- the existing control-plane editor mutation service continues to own canonical request digests, idempotency, and result transition checks;
- a Godot authoring planner resolves targets, selects one history, expands typed operations, and produces deterministic preconditions;
- a resource property adapter owns property-list filtering, type compatibility, and resource preimages;
- a source authoring adapter owns source paths, normalization, parsing, atomic writes, and post-write verification;
- domain adapters own theme, animation, AnimationTree, TileMapLayer, and custom-resource invariants; and
- reference validation verifies ResourceUIDs, canonical paths, indexed assets, embedded resources, and save/reload integrity.

Each component returns prepared steps to the existing transaction boundary. No component commits effects independently.

## 7. Preview, apply, and history selection

Preview resolves every target and returns a deterministic plan containing:

- the selected scene or global history;
- target identities and current revisions;
- expected absent files and expected preimage hashes;
- typed-operation expansion summaries;
- resource and source reference dependencies;
- script and shader parse diagnostics;
- import metadata expectations and observed values;
- predicted changes and warnings; and
- a SHA-256 plan digest over the canonical plan, engine version, project identity, and session generation.

Apply recomputes preview and rejects any plan-digest, revision, UID, property-list, parse, indexed-resource, import-metadata, or project-identity change before the first effect.

One batch resolves to exactly one native Undo/Redo history:

- operations on one already-open scene use that scene's history; or
- source files, project resources, imported-resource references, and closed resource files use global history.

Mixed scene/global batches and batches spanning multiple scene histories fail during preview. Typed operations inherit the history of their resolved target after expansion.

## 8. Transaction, persistence, and rollback

Every authoring apply, undo, and redo is registered with `EditorUndoRedoManager`. Direct file effects use the Phase 5 atomic same-directory transaction and exact byte preimages. In-memory resources retain deterministic property preimages sufficient to restore the affected values and ordered collections.

After apply, undo, and redo, the adapter:

1. saves every affected scene and resource;
2. waits for bounded editor filesystem observation when a source file changed;
3. reloads affected project resources from their canonical paths;
4. verifies expected class, UID/path identity, and resource references;
5. confirms authored scripts and shaders remain parseable; and
6. compares focused behavior state where the operation has a certified fixture assertion.

A failure before commit produces no effects. A failure during commit attempts exact rollback. Results always state whether partial effects occurred and whether rollback was not needed, succeeded, failed, or was not attempted. Unknown outcomes remain journaled as `started`, and retry returns `CONFLICT` instead of repeating the request.

## 9. Bounds

Phase 6 retains the Phase 5 request and transaction bounds:

- 1–32 steps per batch;
- at most 256 KiB serialized request data;
- at most eight touched project files;
- at most 4 MiB retained rollback preimages;
- one scene history or global history per batch;
- maximum Variant nesting depth of eight;
- at most 256 elements per array or dictionary; and
- at most 64 target, precondition, change, and reference records in a result.

Additional Phase 6 bounds are:

- at most 192 KiB normalized source text per file;
- at most 4,096 TileMapLayer coordinates per step and 8,192 per batch;
- at most 256 animation tracks per affected Animation and 4,096 keys changed per batch;
- at most 256 theme item changes per batch;
- at most 64 dependency references per authored resource or source file; and
- post-write editor observation and verification bounded by the existing 30-second mutation timeout.

Any bound violation fails before the first effect.

## 10. Errors, results, and audit

Phase 6 reuses the stable error taxonomy and adds no source-specific raw exception surface. Expected mappings include:

- invalid schema, unsupported Variant, denied property, or invalid source encoding: `INVALID_REQUEST`;
- protected or escaping path: `PATH_DENIED`;
- missing resource, embedded locator, class, property, or indexed asset: `TARGET_NOT_FOUND`;
- stale hash, changed property list, changed UID, changed import expectation, or plan mismatch: `PRECONDITION_FAILED` or `CONFLICT` according to retry semantics;
- script parse failure: `GODOT_PARSE_ERROR`;
- shader parse failure or post-write resource validation failure: `GODOT_PARSE_ERROR`;
- save, reload, or editor filesystem verification failure: `GODOT_RUNTIME_ERROR`; and
- unsuccessful exact restoration: `ROLLBACK_FAILED`.

Successful and failed results include bounded warnings, target identities, preconditions, changes, dependency/reference checks, source parse status, import metadata status, partial-effect state, rollback outcome, and safe recovery guidance. Raw authored source, secret-shaped property values, stack traces, absolute host paths, session keys, and descriptors are excluded from normal results and audit receipts.

Audit records retain source path and pre/post hash, not source content. Resource receipts retain safe property names, resource identities, and revisions, with secret-shaped values recursively redacted.

## 11. Testing strategy

### 11.1 Protocol and control-plane tests

Tests cover every new authoring variant, strict unknown-field rejection, extended Variant encoding, size and collection bounds, expected hashes, property locators, resource references, typed-operation payloads, legacy Phase 5 compatibility, canonical digest stability, idempotent replay, unknown outcomes, and audit redaction.

### 11.2 Godot unit tests

Headless GDScript tests cover:

- property-list allow/deny decisions and Variant compatibility;
- resource and embedded-resource resolution;
- typed-operation expansion and deterministic plans;
- GDScript and shader parsing without deliberate execution;
- source normalization, hash preconditions, and atomic restoration;
- reference, UID, and indexed-import validation;
- theme, animation, AnimationTree, TileMapLayer, and custom-resource invariants; and
- failure injection before commit, during save, and during post-write verification.

### 11.3 Disposable fixture coverage

All real-editor, destructive, hostile, and end-to-end work uses disposable copies of `fixtures/godot-4.7`. The fixture gains focused scenes and resources for:

- Control layout and theme behavior;
- AnimationPlayer and AnimationTree transitions;
- audio resource assignment;
- 2D and 3D physics shapes;
- navigation regions, links, and agents;
- TileMapLayer cell data;
- CPU/GPU particles and process materials;
- standard and shader materials;
- primitive and imported meshes and textures;
- registered custom resources;
- parseable and deliberately malformed scripts and shaders; and
- valid and invalid imported-asset expectations.

Each advertised domain has at least one behavior-level assertion after save/reload, not only a serialized-property assertion.

### 11.4 Integration, security, and E2E

Real-editor integration verifies preview/apply/observe/undo/redo, save/reload persistence, exact preimages, reference integrity, source parsing, conflict detection, and rollback. Hostile tests cover traversal, symlinks, post-validation substitution, protected paths, stale hashes, unsupported properties and types, oversized/deep values, secret-shaped metadata, malformed source, dependency cycles, mixed histories, invalid custom classes, and attempts to escalate into scan/reimport, script execution, arbitrary methods, shell, host files, or network access.

Published stdio E2E exercises representative operations from all three authoring paths:

- introspection-driven resource authoring;
- typed composite authoring; and
- constrained source authoring.

## 12. Certification gate

The Phase 6 gate is:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6
```

It runs, in order:

1. exact Godot version verification;
2. workspace build, lint, and typecheck;
3. protocol and package tests;
4. disposable fixture import and baseline smoke run;
5. Godot Phase 6 authoring unit tests;
6. protocol/control-plane/MCP authoring contract tests;
7. authenticated real-editor authoring integration;
8. hostile Phase 6 authoring tests;
9. published stdio Phase 6 E2E;
10. serialized full Vitest regression;
11. generated protocol and addon-manifest checks;
12. fixture source/preimage and cleanup checks; and
13. `git diff --check`.

Before Phase 6 is called complete, the Phase 0–1, Phase 2, Phase 3, Phase 4, and Phase 5 gates also pass against the same checkout and pinned Godot binary.

## 13. Completion criteria

Phase 6 is complete only when:

- every advertised authoring domain has a strict public contract and a focused behavior-level fixture assertion;
- authored scripts and shaders parse before and after commit without deliberate execution;
- resource and source operations preserve canonical paths, UIDs where applicable, and valid references after save/reload;
- imported assets can be referenced and their expected import metadata validated without exposing scan or reimport commands;
- typed operations and introspection-driven operations share the same preview, authorization, transaction, idempotency, audit, and rollback boundaries;
- Undo restores exact source/file preimages and exact certified resource behavior;
- failed batches either have no effect or report exact partial-effect and rollback status;
- the default observe-only tool surface remains exactly six tools;
- no normal-profile path exposes arbitrary methods, evaluation, shell, host files, network, project operation, build, or export capability; and
- the Phase 6 gate and all required prior-phase gates pass without skipped checks.
