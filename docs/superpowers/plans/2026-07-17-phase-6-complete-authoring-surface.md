# Phase 6 Complete Authoring Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the permission-scoped `godot_editor` transaction surface with constrained source authoring, introspection-driven resource editing, typed complex-domain authoring, imported-asset expectation validation, and complete disposable-fixture certification.

**Architecture:** Keep one public `godot_editor` tool and the existing preview/apply/undo/redo, ledger, authenticated bridge, and native Undo/Redo path. Add focused protocol schemas and Godot adapters that expand every Phase 6 request into the existing prepared scene/global transaction representation; source and resource files use exact atomic preimages, while scene objects use one native scene history.

**Tech Stack:** Node.js 22, TypeScript 6, Zod, MCP SDK, pnpm 11, Vitest 4, Godot 4.7 GDScript, `EditorUndoRedoManager`, `EditorFileSystem`, `ResourceSaver`, authenticated loopback WebSocket bridge.

## Global Constraints

- Keep MCP on stdio and the bridge bound to `127.0.0.1`; the addon opens no listener.
- The default session continues to expose exactly six observe-only tools.
- Phase 6 adds no MCP tool, permission tier, or capability pack; `godot_editor` still requires `project_mutate` plus `editor`.
- Existing Phase 5 requests remain schema-compatible and behavior-compatible.
- Preview is side-effect free; apply requires the preview digest and rechecks every revision, UID, property contract, parse result, and import expectation.
- Apply, undo, and redo require UUID idempotency keys and use the existing durable mutation ledger.
- One batch contains 1–32 steps, serializes to at most 256 KiB, touches at most eight files, retains at most 4 MiB of preimages, and resolves to one scene or global Undo/Redo history.
- Source text is UTF-8, LF-normalized, NUL-free, at most 192 KiB per file, and limited to canonical project-local `.gd` and `.gdshader` paths.
- Do not expose script/shader execution, arbitrary methods, expression evaluation, shell, host filesystem, network, scan/reimport, project settings, plugins, builds, or exports.
- Import/reimport execution remains Phase 9. Phase 6 validates references and expected import metadata only.
- All destructive, hostile, real-editor, and E2E tests use disposable fixture copies.
- Before claiming Phase 6 complete, run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6`, then the Phase 0–1 and Phase 2–5 regression gates.

---

## File Responsibility Map

```text
packages/protocol/src/editorAuthoring.ts                   Phase 6 variants, locators, source and typed authoring steps
packages/protocol/src/editorMutation.ts                    Compose Phase 5 and Phase 6 steps/results
addons/godot_mcp/authoring/authoring_planner.gd            Route/expand Phase 6 steps and select one history
addons/godot_mcp/authoring/resource_locator.gd             Resolve project and embedded resources with revisions
addons/godot_mcp/authoring/resource_property_adapter.gd    Stored-property filtering, typing, and reversible values
addons/godot_mcp/authoring/source_authoring.gd             Normalize, parse, hash, and prepare script/shader files
addons/godot_mcp/authoring/theme_authoring.gd              Theme item operations
addons/godot_mcp/authoring/animation_authoring.gd          Animation/library/track/key and AnimationTree operations
addons/godot_mcp/authoring/tile_authoring.gd               Bounded TileMapLayer cell operations
addons/godot_mcp/authoring/custom_resource_authoring.gd    Deterministic textual custom `.tres` creation
addons/godot_mcp/mutation/editor_variant_decoder.gd        Decode extended bounded Variant tags
addons/godot_mcp/mutation/editor_mutation.gd               Delegate Phase 6 planning and transactions
addons/godot_mcp/mutation/editor_mutation_transaction.gd   Apply prepared scene authoring steps
addons/godot_mcp/mutation/project_file_transaction.gd      Apply prepared source/resource bytes atomically
fixtures/godot-4.7/authoring/**                             Trusted disposable authoring fixture truth
tests/integration/editor-authoring.test.ts                  Real-editor persistence, references, Undo/Redo, behavior
tests/security/editor-authoring-hostile.test.ts             Phase 6 escalation, path, value, source, and conflict attacks
tests/end-to-end/phase-6.test.ts                            Published stdio acceptance
scripts/qa-phase-6.mjs                                     Ordered Phase 6 certification gate
scripts/verify-phase-6-cleanup.mjs                         Fixture diff and transaction-artifact verifier
docs/testing/phase-6.md                                    Certified surface, bounds, exclusions, and gate
```

## Task 1: Define the Phase 6 protocol without widening the tool surface

**Files:**
- Create: `packages/protocol/src/editorAuthoring.ts`
- Create: `packages/protocol/src/editorAuthoring.test.ts`
- Modify: `packages/protocol/src/editorMutation.ts`
- Modify: `packages/protocol/src/editorMutation.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/mcp-server/src/registerEditorTools.test.ts`

**Interfaces:**
- Produces: `EditorAuthoringStepSchema`, `EditorAuthoringStep`, `ExtendedEditorVariantSchema`, `ResourceLocatorSchema`, and `ImportExpectationSchema`.
- Consumes: existing canonical `res://` paths, Phase 5 `EditorVariantSchema`, mutation input/result schemas, and `godot_editor` registration.

- [ ] **Step 1: Write failing schema tests for extended values and source/resource operations**

Add exact acceptance and rejection cases:

```ts
import { describe, expect, it } from "vitest";
import { EditorAuthoringStepSchema, ExtendedEditorVariantSchema } from "./editorAuthoring.js";

describe("Phase 6 authoring schemas", () => {
  it("accepts bounded extended values", () => {
    expect(ExtendedEditorVariantSchema.parse({ type: "vector2i", x: 1, y: 2 })).toEqual({ type: "vector2i", x: 1, y: 2 });
    expect(ExtendedEditorVariantSchema.parse({ type: "rect2", x: 1, y: 2, width: 3, height: 4 })).toMatchObject({ type: "rect2" });
    expect(ExtendedEditorVariantSchema.parse({ type: "packed_int32_array", values: [1, 2, 3] })).toMatchObject({ values: [1, 2, 3] });
  });

  it("accepts hash-bound source replacement", () => {
    expect(EditorAuthoringStepSchema.parse({
      operation: "replace_script",
      sourcePath: "res://authoring/behavior.gd",
      expectedSha256: "a".repeat(64),
      content: "extends Node\n",
    })).toMatchObject({ operation: "replace_script" });
  });

  it("accepts resource properties and import expectations", () => {
    expect(EditorAuthoringStepSchema.parse({
      operation: "set_resource_property",
      target: { resourcePath: "res://authoring/material.tres", propertyPath: [] },
      property: "roughness",
      value: 0.25,
      importExpectation: { importer: "texture", options: { "compress/mode": 0 } },
    })).toMatchObject({ operation: "set_resource_property" });
  });

  it.each([
    { operation: "create_script", sourcePath: "res://addons/escape.gd", content: "extends Node\n" },
    { operation: "create_shader", sourcePath: "res://shader.txt", content: "shader_type canvas_item;" },
    { operation: "replace_script", sourcePath: "res://x.gd", expectedSha256: "bad", content: "extends Node\n" },
    { operation: "set_resource_property", target: { resourcePath: "res://x.tres", propertyPath: Array(9).fill("x") }, property: "x", value: 1 },
  ])("rejects unsafe authoring input %#", (value) => {
    expect(() => EditorAuthoringStepSchema.parse(value)).toThrow();
  });
});
```

- [ ] **Step 2: Run the schema tests and verify the missing module failure**

Run: `pnpm exec vitest run packages/protocol/src/editorAuthoring.test.ts`

Expected: FAIL because `editorAuthoring.ts` does not exist.

- [ ] **Step 3: Implement strict shared schemas and exact Phase 6 step variants**

Define `ResourceLocatorSchema` as `{ resourcePath, propertyPath }`, with a canonical `.tres`, `.res`, or already-indexed imported-resource path and at most eight identifier path segments. Define `ImportExpectationSchema` as an importer name plus at most 64 scalar option expectations.

Define these exact operations in `EditorAuthoringStepSchema`:

```ts
export const AUTHORING_OPERATIONS = [
  "set_resource_property", "set_resource_metadata", "remove_resource_metadata", "assign_resource_reference",
  "configure_control_layout", "set_theme_item", "remove_theme_item",
  "upsert_animation", "remove_animation", "upsert_animation_track", "remove_animation_track",
  "upsert_animation_key", "remove_animation_key", "configure_animation_tree",
  "set_tile_cells", "erase_tile_cells", "create_custom_resource",
  "create_script", "replace_script", "create_shader", "replace_shader",
] as const;
```

Use strict discriminated objects. Source creates omit `expectedSha256`; replacements require a lowercase 64-character SHA-256. Control layout targets one scene/node and accepts anchors/offsets in `[0,1]`/finite pixel ranges. Theme item kinds are `color|constant|font|font_size|icon|stylebox`. Animation track types are the Godot 4.7 stable track enum names and keys carry finite time plus an extended Variant value. Tile cells contain unique coordinates, source ID, atlas coordinates, and alternative tile.

- [ ] **Step 4: Compose Phase 6 steps into the existing mutation contract**

Export `EditorMutationStepSchema` as the union of the Phase 5 step union and `EditorAuthoringStepSchema`. Extend mutation target kinds and change operation names using `AUTHORING_OPERATIONS`. Keep top-level preview/apply/undo/redo unchanged and retain the 32-step/256 KiB refinement.

Update the MCP test to assert one `godot_editor` tool, unchanged annotations, and an input schema that accepts one Phase 6 preview. Assert observe-only remains exactly six tools.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run packages/protocol/src/editorAuthoring.test.ts packages/protocol/src/editorMutation.test.ts packages/mcp-server/src/registerEditorTools.test.ts packages/control-plane/src/policy`

Expected: PASS.

```bash
git add packages/protocol/src/editorAuthoring.ts packages/protocol/src/editorAuthoring.test.ts packages/protocol/src/editorMutation.ts packages/protocol/src/editorMutation.test.ts packages/protocol/src/index.ts packages/mcp-server/src/registerEditorTools.test.ts
git commit -m "feat: define Phase 6 authoring contracts"
```

## Task 2: Decode extended values and resolve safe resource targets

**Files:**
- Create: `addons/godot_mcp/authoring/resource_locator.gd`
- Create: `addons/godot_mcp/authoring/resource_property_adapter.gd`
- Create: `fixtures/godot-4.7/tests/authoring_resource_unit.gd`
- Modify: `addons/godot_mcp/mutation/editor_variant_decoder.gd`
- Modify: `addons/godot_mcp/observation/variant_encoder.gd`

**Interfaces:**
- Produces: `GodotMcpResourceLocator.resolve(locator, filesystem)`, `GodotMcpResourcePropertyAdapter.prepare(step, filesystem)`, and symmetric extended Variant encode/decode.
- Consumes: `ResourceLocatorSchema`, editor filesystem indexing, `PROPERTY_USAGE_STORAGE`, and Phase 5 bounds.

- [ ] **Step 1: Write failing Godot unit assertions**

The fixture script must assert:

```gdscript
var decoded := VariantDecoder.decode({"type": "vector2i", "x": 3, "y": 4})
assert(decoded.ok and decoded.value == Vector2i(3, 4))
assert(not VariantDecoder.decode({"type": "packed_float32_array", "values": [NAN]}).ok)
var located := ResourceLocator.resolve({"resourcePath": "res://authoring/material.tres", "propertyPath": []}, filesystem)
assert(located.ok and located.resource is StandardMaterial3D)
var denied := PropertyAdapter.prepare({"operation": "set_resource_property", "target": {"resourcePath": "res://authoring/material.tres", "propertyPath": []}, "property": "script", "value": null}, filesystem)
assert(not denied.ok and denied.code == "PATH_DENIED")
```

- [ ] **Step 2: Run the unit script and verify it fails on missing adapters**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm build && /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_resource_unit.gd`

Expected: non-zero exit because the Phase 6 adapters do not exist.

- [ ] **Step 3: Implement symmetric extended Variant support**

Support `vector2i`, `vector3i`, `vector4`, `vector4i`, `rect2`, `rect2i`, `transform2d`, `transform3d`, `quaternion`, `plane`, `aabb`, `basis`, `projection`, `string_name`, and packed byte/int32/int64/float32/float64/string/vector2/vector3/color arrays. Require exact fields, finite numeric members, depth eight, 256 members per general collection, and 4,096 entries per packed array. Keep Script, Object, RID, Callable, Signal, and unknown tags denied.

- [ ] **Step 4: Implement resource location, revision, and property filtering**

`resolve()` must require an indexed canonical project resource, load only that exact path, reject Script resources, traverse at most eight stored Resource-valued property segments, and return `{ resource, root, identity, revision }`. The revision is SHA-256 over canonical encoded class, path/UID, property path, and recursively encoded stored properties with secret-shaped values redacted.

`prepare()` must inspect the real property list, require `PROPERTY_USAGE_STORAGE`, reject `script`, `_`-prefixed/editor-only/read-only/secret-shaped names, validate Variant type and `PROPERTY_HINT_RESOURCE_TYPE`, and return a prepared reversible step containing `_resource`, `_before`, and `_after`.

- [ ] **Step 5: Pass the Godot unit script and focused package tests, then commit**

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_resource_unit.gd`

Expected: exit 0 with `PHASE6_RESOURCE_UNIT_OK`.

```bash
git add addons/godot_mcp/authoring/resource_locator.gd addons/godot_mcp/authoring/resource_property_adapter.gd addons/godot_mcp/mutation/editor_variant_decoder.gd addons/godot_mcp/observation/variant_encoder.gd fixtures/godot-4.7/tests/authoring_resource_unit.gd
git commit -m "feat: add safe resource authoring primitives"
```

## Task 3: Add constrained script and shader file transactions

**Files:**
- Create: `addons/godot_mcp/authoring/source_authoring.gd`
- Create: `fixtures/godot-4.7/tests/authoring_source_unit.gd`
- Modify: `addons/godot_mcp/mutation/project_file_transaction.gd`
- Test: `packages/protocol/src/editorAuthoring.test.ts`

**Interfaces:**
- Produces: `GodotMcpSourceAuthoring.prepare(step)` returning prepared `paths`, `before`, `after`, parse diagnostics, and reference records.
- Consumes: canonical source schemas, exact preimage hashes, atomic project-file transaction, and editor filesystem `update_file`.

- [ ] **Step 1: Write failing source normalization and parse tests**

Assert create, replace, CRLF normalization, stale hash, addon/hidden/symlink denial, NUL and invalid UTF-8 denial, 192 KiB limit, malformed GDScript, malformed shader, and source text omission from returned diagnostics.

Use fixture truth:

```gdscript
var script_ok := SourceAuthoring.prepare({"operation": "create_script", "sourcePath": "res://authoring/generated.gd", "content": "extends Node\r\nvar value := 1\r\n"})
assert(script_ok.ok and script_ok.normalized_content == "extends Node\nvar value := 1\n")
var script_bad := SourceAuthoring.prepare({"operation": "create_script", "sourcePath": "res://authoring/bad.gd", "content": "extends Node\nfunc broken(\n"})
assert(not script_bad.ok and script_bad.code == "GODOT_PARSE_ERROR")
var shader_bad := SourceAuthoring.prepare({"operation": "create_shader", "sourcePath": "res://authoring/bad.gdshader", "content": "shader_type canvas_item; void fragment( {"})
assert(not shader_bad.ok and shader_bad.code == "GODOT_PARSE_ERROR")
```

- [ ] **Step 2: Run the source unit and verify the missing adapter failure**

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_source_unit.gd`

Expected: non-zero exit because `source_authoring.gd` is missing.

- [ ] **Step 3: Implement source preparation and in-memory parsing**

Normalize CRLF/CR to LF; reject NUL and content above 192 KiB. Permit only `.gd` for script operations and `.gdshader` for shader operations through the existing protected/symlink-safe project path checker. Create requires absence. Replace requires the current SHA-256 to equal `expectedSha256`.

For GDScript, set normalized source on a fresh `GDScript`, call `reload()`, and return `GODOT_PARSE_ERROR` on failure without instantiating it. For shaders, assign code to a fresh `Shader`, require a valid source shape and capture editor shader errors through the bounded diagnostic logger path. Return only bounded normalized diagnostics.

- [ ] **Step 4: Generalize atomic file transactions for prepared bytes**

Add `prepare_external(prepared_step)` to `project_file_transaction.gd`. It accepts only a step produced by a preloaded addon adapter, reruns `_safe_path`, captures current state, verifies expected absence/hash, enforces eight-file/4 MiB totals, and stores exact desired bytes. It must not accept arbitrary caller bytes directly from `editor_mutation.gd`.

- [ ] **Step 5: Pass source units and transaction regression tests, then commit**

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_source_unit.gd && pnpm exec vitest run packages/protocol/src/editorAuthoring.test.ts tests/integration/editor-mutation.test.ts`

Expected: PASS.

```bash
git add addons/godot_mcp/authoring/source_authoring.gd addons/godot_mcp/mutation/project_file_transaction.gd fixtures/godot-4.7/tests/authoring_source_unit.gd packages/protocol/src/editorAuthoring.test.ts
git commit -m "feat: transact constrained Godot source files"
```

## Task 4: Implement typed theme, animation, TileMapLayer, and custom-resource adapters

**Files:**
- Create: `addons/godot_mcp/authoring/theme_authoring.gd`
- Create: `addons/godot_mcp/authoring/animation_authoring.gd`
- Create: `addons/godot_mcp/authoring/tile_authoring.gd`
- Create: `addons/godot_mcp/authoring/custom_resource_authoring.gd`
- Create: `fixtures/godot-4.7/tests/authoring_domains_unit.gd`

**Interfaces:**
- Produces: each adapter's `prepare(step, context)` result with deterministic reversible prepared steps.
- Consumes: resolved resources/nodes, extended Variant decoding, editor class registry, and Phase 6 collection bounds.

- [ ] **Step 1: Write failing domain behavior units**

Create fixture assertions for:

- Control anchors/offsets and one Theme color/constant/stylebox item;
- an Animation library, value track, ordered keys, and AnimationTree parameter path;
- TileMapLayer set/erase over unique coordinates; and
- deterministic custom `.tres` text containing a registered script UID and only declared exported properties.

The unit must apply each prepared step forward and backward and assert exact before/after behavior.

- [ ] **Step 2: Run the domain unit and verify missing adapter failures**

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_domains_unit.gd`

Expected: non-zero exit because the four domain adapters are missing.

- [ ] **Step 3: Implement theme and Control layout preparation**

Resolve one Control node for `configure_control_layout`, validate finite anchors/offsets/grow/minimum-size/size-flags, and capture every changed property. Theme operations resolve a Theme resource, map the public item kind to the exact Godot `set_*`/`clear_*` pair, validate theme type/name identifiers, and retain whether the item previously existed plus its old value.

- [ ] **Step 4: Implement animation and AnimationTree preparation**

Resolve AnimationLibrary/Animation resources and convert track names to the stable Godot 4.7 track enum. Validate relative node/property track paths, unique library/animation names, finite nonnegative key times, 256-track and 4,096-key limits, and type-compatible key values. Prepared operations retain copied preimage resources or exact track/key state so reverse application restores ordering and interpolation.

`configure_animation_tree` accepts only `tree_root`, `active`, `process_callback`, `root_motion_track`, and parameter paths already exposed by the target AnimationTree property list.

- [ ] **Step 5: Implement bounded TileMapLayer and custom Resource preparation**

Tile steps resolve one TileMapLayer, require unique `Vector2i` coordinates, validate source/atlas/alternative IDs against its TileSet, and capture every prior cell tuple before applying or erasing.

Custom Resource creation resolves the class name through the editor filesystem script-class registry, requires a Resource base, reads exported stored-property declarations without instantiating the class, serializes deterministic textual `.tres` with sorted properties and the registered script reference, and returns a prepared global file step. Reject `_init` arguments, unknown exports, object-like values, and any class absent from the registry.

- [ ] **Step 6: Pass domain units and commit**

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_domains_unit.gd`

Expected: exit 0 with `PHASE6_DOMAINS_UNIT_OK`.

```bash
git add addons/godot_mcp/authoring fixtures/godot-4.7/tests/authoring_domains_unit.gd
git commit -m "feat: add typed Godot authoring adapters"
```

## Task 5: Integrate authoring planning with Phase 5 preview/apply/undo/redo

**Files:**
- Create: `addons/godot_mcp/authoring/authoring_planner.gd`
- Modify: `addons/godot_mcp/mutation/editor_mutation.gd`
- Modify: `addons/godot_mcp/mutation/editor_mutation_transaction.gd`
- Modify: `addons/godot_mcp/plugin.gd`
- Modify: `packages/control-plane/src/editor/editorMutationService.test.ts`
- Modify: `packages/mcp-server/src/registerEditorTools.ts`
- Modify: `packages/mcp-server/src/registerEditorTools.test.ts`

**Interfaces:**
- Produces: `GodotMcpAuthoringPlanner.preview_step(step)` and `prepare_steps(steps, history)`; enriched Phase 6 mutation results.
- Consumes: Tasks 1–4 adapters and existing mutation service/ledger/tool.

- [ ] **Step 1: Write failing integration-level contract tests**

Assert that preview forwards Phase 6 steps unchanged, apply requires the same plan digest, completed apply replays from the ledger, stale resource/source/import expectations fail before effects, audit summaries include only operation counts/hashes, and raw source never appears in audit arguments.

- [ ] **Step 2: Implement deterministic planning and import expectation checks**

The planner routes by operation, resolves the target, validates expected importer/options through editor metadata without calling scan/reimport, selects `scene` or `global`, and emits target/precondition/change/reference/parse/import records. Plan input uses canonical JSON over expanded operations, revisions, Godot version, project identity, and session generation.

- [ ] **Step 3: Delegate Phase 6 preview and apply from `editor_mutation.gd`**

Keep Phase 5 routing unchanged. For Phase 6 operations, call the planner during `_preview`; during `_apply`, re-run preview, compare the digest, prepare scene or file transactions, register every do/undo method with the selected `EditorUndoRedoManager` history, save affected resources/scenes, update changed source files, reload affected resources, and verify references/parse state before returning success.

On failure, preserve the current result shape:

```gdscript
return {
  "ok": false,
  "code": failure_code,
  "message": safe_message,
  "retryable": false,
  "failedPhase": failed_phase,
  "partialEffects": partial_effects,
  "rollback": rollback,
  "safeRecovery": safe_recovery,
}
```

- [ ] **Step 4: Update scene and file transaction dispatch**

Scene prepared operations call the focused adapter's static apply function with retained preimages. Global prepared operations use `prepare_external`. Undo/redo must re-run save/reload/reference verification and refuse to consume an intervening human action exactly as Phase 5 does.

- [ ] **Step 5: Keep MCP registration stable and redact source summaries**

Change the tool title/description to include authoring while retaining the same name and annotations. `summarizeEditorMutationForAudit` records step operation counts, source paths, and content SHA-256 values but never source content or property values.

- [ ] **Step 6: Run focused TypeScript and Godot tests, then commit**

Run: `pnpm exec vitest run packages/control-plane/src/editor packages/mcp-server/src/registerEditorTools.test.ts packages/protocol/src/editorAuthoring.test.ts packages/protocol/src/editorMutation.test.ts`

Run: `/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_resource_unit.gd && /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_source_unit.gd && /opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --script res://tests/authoring_domains_unit.gd`

Expected: PASS.

```bash
git add addons/godot_mcp packages/control-plane/src/editor/editorMutationService.test.ts packages/mcp-server/src/registerEditorTools.ts packages/mcp-server/src/registerEditorTools.test.ts
git commit -m "feat: integrate transactional authoring"
```

## Task 6: Build complete disposable fixture and real-editor integration coverage

**Files:**
- Create: `fixtures/godot-4.7/authoring/authoring_scene.tscn`
- Create: `fixtures/godot-4.7/authoring/authoring_theme.tres`
- Create: `fixtures/godot-4.7/authoring/authoring_animation_library.tres`
- Create: `fixtures/godot-4.7/authoring/authoring_tileset.tres`
- Create: `fixtures/godot-4.7/authoring/authoring_material.tres`
- Create: `fixtures/godot-4.7/authoring/custom_resource.gd`
- Create: `fixtures/godot-4.7/authoring/custom_resource.tres`
- Create: `fixtures/godot-4.7/authoring/valid_script.gd`
- Create: `fixtures/godot-4.7/authoring/valid_shader.gdshader`
- Create: `tests/integration/editor-authoring.test.ts`

**Interfaces:**
- Produces: trusted fixture truth and authenticated editor integration acceptance.
- Consumes: published addon files, bridge session, disposable fixture helper, and Phase 6 public schemas.

- [ ] **Step 1: Write the failing real-editor integration test**

The test must use `copyFixture`, import it, install/enable the addon, launch the editor, attach through the authenticated bridge, and cover:

1. resource property preview/apply/save/reload/undo/redo;
2. Control/theme behavior;
3. animation/AnimationTree behavior;
4. audio, physics, navigation, particles, materials, meshes, and textures through introspection-driven properties and typed resource references;
5. TileMapLayer cell behavior;
6. custom Resource creation and structural reference validation;
7. script and shader create/replace with parse status;
8. imported asset expectation validation without calling reimport; and
9. exact project preimages after final undo and cleanup.

- [ ] **Step 2: Run the integration test and verify fixture/behavior failures**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/editor-authoring.test.ts`

Expected: FAIL until the fixture and full behavior assertions exist.

- [ ] **Step 3: Add minimal deterministic fixture resources**

Use Godot 4.7 text formats with stable paths and no external dependencies beyond committed fixture files. `authoring_scene.tscn` contains one Control, AnimationPlayer, AnimationTree, AudioStreamPlayer, physics bodies/shapes, navigation nodes, TileMapLayer, GPUParticles2D, MeshInstance3D, and Sprite2D. The custom script declares exported scalar/resource fields and has no `_init`, `_ready`, `@tool`, networking, filesystem, or process behavior.

- [ ] **Step 4: Complete behavior and exact-preimage assertions**

For each domain, assert a Godot-observed behavior value after save/reload, not only file text. Hash all fixture source files before the test and assert exact restoration after undo/cleanup. Assert no descriptor, mutation temporary/backup, unexpected `.godot/godot-mcp` journal, or owned process remains.

- [ ] **Step 5: Pass integration and Phase 5 regression, then commit**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/editor-authoring.test.ts tests/integration/editor-mutation.test.ts`

Expected: PASS.

```bash
git add fixtures/godot-4.7/authoring tests/integration/editor-authoring.test.ts
git commit -m "test: verify complete editor authoring"
```

## Task 7: Add hostile-input and published stdio acceptance

**Files:**
- Create: `tests/security/editor-authoring-hostile.test.ts`
- Create: `tests/end-to-end/phase-6.test.ts`
- Modify: `packages/testkit/src/e2e.ts`
- Modify: `packages/testkit/src/index.ts`

**Interfaces:**
- Produces: hostile Phase 6 safety proof and published-build stdio acceptance.
- Consumes: disposable projects, real editor bridge, MCP stdio client, and operation/result schemas.

- [ ] **Step 1: Write hostile cases before implementation adjustments**

Use table-driven cases for absolute/traversing/protected/symlink/post-validation paths, source extensions, stale hashes, oversized source, NUL, malformed script/shader, secret-shaped properties/metadata, unsupported Variant tags, object/script references, unknown/constructor-bearing custom classes, invalid resource hints, missing UIDs, changed import expectations, duplicate/oversized TileMap coordinates, animation path/type/key limits, mixed histories, unknown outcomes, source in audit, and attempts to request scan/reimport/method/shell/network operations.

Every case asserts stable code, no project diff, no source leakage, a redacted audit receipt, and no owned process or descriptor leak.

- [ ] **Step 2: Run hostile tests and fix only demonstrated boundary gaps**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/security/editor-authoring-hostile.test.ts`

Expected before fixes: FAIL on any missing boundary assertion. After narrow fixes: PASS.

- [ ] **Step 3: Write published stdio E2E**

Build packages, launch the installed CLI/MCP server against a disposable fixture, grant `project_mutate + editor`, assert exactly seven visible tools (six core plus `godot_editor`), then execute preview/apply/query/undo/redo for one resource property, one typed composite, and one source operation. Verify observe-only exposes six and cannot call `godot_editor`.

- [ ] **Step 4: Run E2E and full focused Phase 6 tests, then commit**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm build && pnpm exec vitest run tests/end-to-end/phase-6.test.ts tests/security/editor-authoring-hostile.test.ts tests/integration/editor-authoring.test.ts`

Expected: PASS.

```bash
git add tests/security/editor-authoring-hostile.test.ts tests/end-to-end/phase-6.test.ts packages/testkit/src/e2e.ts packages/testkit/src/index.ts
git commit -m "test: certify Phase 6 authoring boundaries"
```

## Task 8: Add the Phase 6 gate, documentation, and repository pointers

**Files:**
- Create: `scripts/qa-phase-6.mjs`
- Create: `scripts/verify-phase-6-cleanup.mjs`
- Create: `docs/testing/phase-6.md`
- Modify: `package.json`
- Modify: `tests/meta/workspace.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `pnpm qa:phase-6`, current contributor pointers, and the certified Phase 6 contract.
- Consumes: all prior tasks and the pinned Godot binary/version.

- [ ] **Step 1: Write the failing workspace gate test**

Assert `package.json` contains `"qa:phase-6": "node scripts/qa-phase-6.mjs"`; the script contains the pinned version check, build/lint/typecheck, focused Phase 6 tests, serialized full Vitest, generated checks, cleanup/preimage checks, and diff check; and `AGENTS.md` points to the Phase 6 plan and gate.

- [ ] **Step 2: Run the meta test and verify it fails**

Run: `pnpm exec vitest run tests/meta/workspace.test.ts`

Expected: FAIL because the Phase 6 gate and pointers do not exist.

- [ ] **Step 3: Implement the ordered gate**

Use `spawnSync` with inherited stdio and stop on the first non-zero status. Run:

```text
Godot exact version
pnpm build
pnpm lint
pnpm typecheck
pnpm exec vitest run packages/protocol/src/editorAuthoring.test.ts packages/protocol/src/editorMutation.test.ts packages/control-plane/src/editor packages/mcp-server/src/registerEditorTools.test.ts
Godot fixture import
three Phase 6 Godot unit scripts
pnpm exec vitest run tests/integration/editor-authoring.test.ts
pnpm exec vitest run tests/security/editor-authoring-hostile.test.ts
pnpm exec vitest run tests/end-to-end/phase-6.test.ts
pnpm exec vitest run --fileParallelism=false
node scripts/generate-godot-protocol.mjs --check
node scripts/verify-phase-6-cleanup.mjs
git diff --check
```

`verify-phase-6-cleanup.mjs` runs `git diff --exit-code -- fixtures/godot-4.7` and recursively rejects files under the fixture matching `.godot-mcp-*.tmp`, `.godot-mcp-*.bak`, or `.godot/godot-mcp/mutation-journal/**`. It exits non-zero with the relative offending path and never deletes evidence.

- [ ] **Step 4: Document certified behavior and update current pointers**

`docs/testing/phase-6.md` lists the exact operation families, bounds, permissions, source constraints, import/reimport exclusion, fixtures, gate, and required prior-phase regressions. Update `AGENTS.md` current plan, phase gate, and validation paragraph from Phase 4 to Phase 6. Update README capability status without claiming Phase 7–11 functionality.

- [ ] **Step 5: Run meta/focused checks and commit**

Run: `pnpm exec vitest run tests/meta/workspace.test.ts packages/protocol/src/editorAuthoring.test.ts packages/mcp-server/src/registerEditorTools.test.ts`

Expected: PASS.

```bash
git add scripts/qa-phase-6.mjs scripts/verify-phase-6-cleanup.mjs docs/testing/phase-6.md package.json tests/meta/workspace.test.ts AGENTS.md README.md
git commit -m "test: add Phase 6 certification gate"
```

## Task 9: Run certification and prior-phase regressions

**Files:**
- Verify only; modify implementation or tests only when a check demonstrates a Phase 6 defect.

**Interfaces:**
- Consumes: completed Tasks 1–8.
- Produces: current terminal evidence for Phase 6 and Phase 0–5 regression status.

- [ ] **Step 1: Verify the working tree and Phase 6 diff**

Run: `git status --short && git diff --check HEAD~8..HEAD`

Expected: clean working tree and no whitespace errors.

- [ ] **Step 2: Run the authoritative Phase 6 gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-6`

Expected: every ordered stage passes; no skipped stage is reported as passed.

- [ ] **Step 3: Run required regression gates serially**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5
```

Expected: all five gates pass against the same checkout and Godot binary.

- [ ] **Step 4: Record final evidence without changing certified behavior**

Run: `git status --short --branch && git log --oneline -12`

Expected: clean branch with the Phase 6 task commits present. Report exact gate results and any explicitly skipped external/platform checks; do not claim Windows, Linux, Godot 4.4–4.6, Phase 7–11, or release certification.
