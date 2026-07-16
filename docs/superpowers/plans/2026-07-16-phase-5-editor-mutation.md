# Phase 5 Editor Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permission-scoped `godot_editor` tool that previews, applies, undoes, and redoes bounded scene, node, property, metadata, group, signal, owner, and resource mutations with native Godot Undo/Redo, durable idempotency, conflict detection, journaling, save/reload persistence, and exact rollback reporting.

**Architecture:** Extend the existing protocol → MCP adapter → control plane → authenticated editor bridge → main-thread Godot adapter flow. The control plane owns authorization, idempotency, audit normalization, and request bounds; Godot owns target resolution, preimage revisions, one-history batch validation, `EditorUndoRedoManager` actions, project-local atomic file writes, save/reload, and rollback. A batch may target one open-scene undo history or the global resource/file history, never both or multiple scene histories.

**Tech Stack:** Node.js 22, TypeScript 6, Zod, MCP SDK, pnpm 11, Vitest 4, Godot 4.7 GDScript, `EditorUndoRedoManager`, `EditorInterface`, `PackedScene`, `ResourceSaver`, authenticated loopback WebSocket bridge.

## Global Constraints

- Keep MCP on stdio and the bridge bound to `127.0.0.1`; the addon opens no listener.
- The default session continues to expose exactly six observe-only tools.
- Phase 5 adds exactly one tool, `godot_editor`, only when both `project_mutate` and `editor` are explicitly granted.
- Every apply, undo, and redo request requires a UUID idempotency key; key reuse with a different canonical request digest returns `CONFLICT`.
- Preview is side-effect free and returns the plan digest required by apply.
- A batch contains 1–32 steps, serializes to at most 256 KiB, touches at most 8 project files, and retains at most 4 MiB of rollback preimages.
- Every batch resolves to exactly one native undo history: one already-open scene, or Godot global history for scene/resource files. Reject mixed or multi-scene histories before the first effect.
- Normal profiles may instantiate only engine classes validated by `ClassDB` and explicit project script classes from the editor filesystem registry. Unknown class names are never treated as paths.
- Scene and resource paths are canonical `res://` paths; reject absolute paths, traversal, subnames, `.git`, environment/credential names, addon files, `.godot` outside the dedicated journal directory, symlink escapes, and post-validation substitution.
- Node targets are relative descendant `NodePath` values with no traversal or subnames and must belong to an already-open scene.
- Use native `EditorUndoRedoManager` for every mutation. Direct project-file effects must be registered as do/undo methods and use atomic temp-write/rename helpers.
- Save affected scenes/resources after apply, undo, and redo. A save failure is a mutation failure and triggers rollback when possible.
- Never expose arbitrary method invocation, arbitrary file reads/writes, script evaluation, shell, host filesystem, or network access.
- Mutation results and audit receipts report target identities, preconditions, pre/post revisions, changes, partial effects, rollback attempt/outcome, warnings, and safe recovery.
- All destructive, hostile-input, editor, and E2E tests use disposable copies of `fixtures/godot-4.7`; never mutate a real game checkout.
- Before claiming Phase 5 complete, run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5`, then the Phase 0–1, Phase 2, Phase 3, and Phase 4 regression gates.

---

## File Responsibility Map

```text
packages/protocol/src/editorMutation.ts                 Public mutation schemas and result types
packages/control-plane/src/editor/mutationLedger.ts     Durable idempotency and unknown-outcome reconciliation
packages/control-plane/src/editor/editorMutationService.ts Authorization-independent orchestration over the bridge
packages/mcp-server/src/registerEditorTools.ts          The single permission-scoped godot_editor MCP tool
addons/godot_mcp/mutation/editor_mutation.gd            Planning, target resolution, revisions, Undo/Redo actions
addons/godot_mcp/mutation/editor_variant_decoder.gd      Strict typed JSON-to-Variant conversion
addons/godot_mcp/mutation/project_file_transaction.gd    Bounded atomic res:// preimages, writes, moves, deletes
fixtures/godot-4.7/mutation/*                            Disposable mutation scenes/resources and assertions
tests/integration/editor-mutation.test.ts                Real-editor success, persistence, Undo/Redo, rollback
tests/security/editor-mutation-hostile.test.ts            Permissions, paths, conflicts, limits, malicious values
tests/end-to-end/phase-5.test.ts                         Published stdio acceptance through godot_editor
scripts/qa-phase-5.mjs                                   Phase 5 certification and prior-phase regressions
docs/testing/phase-5.md                                  Certified contract, limits, and exclusions
```

## Task 1: Define the Phase 5 protocol and capability contract

**Files:**
- Create: `packages/protocol/src/editorMutation.ts`
- Create: `packages/protocol/src/editorMutation.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/control-plane/src/policy/capabilities.ts`
- Modify: `packages/control-plane/src/policy/capabilities.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces: `EditorMutationInputSchema`, `EditorMutationResultSchema`, `EditorMutationInput`, `EditorMutationResult`, `EditorMutationStep`, and `EDITOR_POLICY`.
- Consumes: existing `PermissionTierSchema`, `CapabilityPackSchema`, canonical JSON conventions, and stable error codes.

- [ ] **Step 1: Write failing protocol tests for the exact public surface**

Test the four top-level operations and strict rejection:

```ts
import { describe, expect, it } from "vitest";
import { EditorMutationInputSchema } from "./editorMutation.js";

const scene = "res://mutation/editor_mutation.tscn";
const key = "019f6f52-6b15-7e21-bda3-101112131415";
const digest = "a".repeat(64);

describe("EditorMutationInputSchema", () => {
  it("accepts preview and apply batches", () => {
    const steps = [{ operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: { type: "vector2", x: 12, y: 34 } }];
    expect(EditorMutationInputSchema.parse({ operation: "preview", steps })).toMatchObject({ operation: "preview", steps });
    expect(EditorMutationInputSchema.parse({ operation: "apply", idempotencyKey: key, expectedPlanDigest: digest, steps })).toMatchObject({ operation: "apply", idempotencyKey: key });
  });

  it("accepts action-scoped undo and redo", () => {
    expect(EditorMutationInputSchema.parse({ operation: "undo", actionId: key, idempotencyKey: "019f6f52-6b15-7e21-bda3-202122232425" }).operation).toBe("undo");
    expect(EditorMutationInputSchema.parse({ operation: "redo", actionId: key, idempotencyKey: "019f6f52-6b15-7e21-bda3-303132333435" }).operation).toBe("redo");
  });

  it("rejects traversal, subnames, unbounded batches, nonfinite values, and unknown fields", () => {
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: Array.from({ length: 33 }, () => ({ operation: "create_node", scenePath: scene, parentPath: ".", className: "Node", name: "N" })) })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [{ operation: "delete_node", scenePath: scene, nodePath: "../Outside" }] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [{ operation: "set_property", scenePath: scene, nodePath: "Target:position", property: "position", value: 1 }] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "preview", steps: [{ operation: "set_property", scenePath: scene, nodePath: "Target", property: "position", value: Number.POSITIVE_INFINITY }] })).toThrow();
    expect(() => EditorMutationInputSchema.parse({ operation: "undo", actionId: key, idempotencyKey: key, extra: true })).toThrow();
  });
});
```

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `pnpm exec vitest run packages/protocol/src/editorMutation.test.ts`

Expected: FAIL because `editorMutation.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and bounded typed variants**

Define:

```ts
export const EditorVariantSchema = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(16_384),
  z.object({ type: z.literal("vector2"), x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({ type: z.literal("vector3"), x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict(),
  z.object({ type: z.literal("color"), r: z.number().finite(), g: z.number().finite(), b: z.number().finite(), a: z.number().finite() }).strict(),
  z.object({ type: z.literal("node_path"), value: NodePathSchema }).strict(),
  z.object({ type: z.literal("resource_ref"), path: ResourcePathSchema }).strict(),
  z.array(EditorVariantSchema).max(256),
  z.record(z.string().max(128), EditorVariantSchema).refine((value) => Object.keys(value).length <= 256),
]));
```

Define a discriminated `EditorMutationStepSchema` with these exact operations:

```text
create_scene, duplicate_scene, move_scene, delete_scene
create_resource, duplicate_resource, move_resource, delete_resource
create_node, duplicate_node, move_node, rename_node, reparent_node, delete_node
set_property, set_metadata, remove_metadata, add_group, remove_group
connect_signal, disconnect_signal, set_owner
```

Every scene/node step includes `scenePath`; every existing node uses `nodePath`; created engine objects use `className` and never a path; file destinations use `destinationPath`. Apply uses `expectedPlanDigest`, and undo/redo use `actionId`. Apply, undo, and redo require UUID idempotency keys. Add a serialized-size refinement capped at 256 KiB.

- [ ] **Step 4: Add the editor capability policy**

Add and export:

```ts
export const EDITOR_POLICY: CommandPolicy = {
  command: "godot_editor",
  tier: "project_mutate",
  pack: "editor",
  mutating: true,
};
export const EDITOR_POLICIES: readonly CommandPolicy[] = [EDITOR_POLICY];
```

Include editor policies in `visibleCapabilities()`. Assert observe-only stays six core policies, `runtime_control` does not imply editor, and `{ tiers: ["project_mutate"], packs: ["core", "editor"] }` exposes exactly one additional command.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run packages/protocol/src/editorMutation.test.ts packages/control-plane/src/policy`

Expected: PASS.

```bash
git add packages/protocol/src/editorMutation.ts packages/protocol/src/editorMutation.test.ts packages/protocol/src/index.ts packages/control-plane/src/policy/capabilities.ts packages/control-plane/src/policy/capabilities.test.ts packages/control-plane/src/index.ts
git commit -m "feat: define editor mutation contracts"
```

## Task 2: Add durable idempotency, rich mutation receipts, and control-plane orchestration

**Files:**
- Create: `packages/control-plane/src/editor/mutationLedger.ts`
- Create: `packages/control-plane/src/editor/mutationLedger.test.ts`
- Create: `packages/control-plane/src/editor/editorMutationService.ts`
- Create: `packages/control-plane/src/editor/editorMutationService.test.ts`
- Modify: `packages/control-plane/src/audit/jsonlAuditSink.ts`
- Modify: `packages/control-plane/src/audit/jsonlAuditSink.test.ts`
- Modify: `packages/control-plane/src/errors.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/protocol/src/schemas.ts`
- Modify: `packages/protocol/src/schemas.test.ts`
- Modify: `packages/mcp-server/src/executeTool.ts`
- Modify: `packages/mcp-server/src/executeTool.test.ts`

**Interfaces:**
- Consumes: `EditorMutationInput`, `EditorMutationResult`, `ProjectIdentity`, `BridgeCommandRequester`-compatible request function, `JsonlAuditSink`.
- Produces: `MutationLedger.reconcile()`, `MutationLedger.begin()`, `MutationLedger.complete()`, and `EditorMutationService.execute(input, correlationId)`.

- [ ] **Step 1: Write failing ledger tests**

Cover completed replay, key mismatch, crash-left `started` records, bounded startup replay, and redaction:

```ts
it("returns a completed receipt without dispatching the mutation twice", async () => {
  const ledger = await MutationLedger.open(path);
  await ledger.begin({ idempotencyKey: key, requestDigest, correlationId: "req-1" });
  await ledger.complete({ idempotencyKey: key, requestDigest, correlationId: "req-1", result });
  await expect((await MutationLedger.open(path)).reconcile(key, requestDigest)).resolves.toEqual({ state: "completed", result });
});

it("rejects key reuse and reports an unknown prior outcome", async () => {
  const ledger = await MutationLedger.open(path);
  await ledger.begin({ idempotencyKey: key, requestDigest, correlationId: "req-1" });
  await expect(ledger.reconcile(key, "b".repeat(64))).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(ledger.reconcile(key, requestDigest)).resolves.toEqual({ state: "unknown" });
});
```

- [ ] **Step 2: Implement the append-only mutation ledger**

Store owner-only JSONL at `.godot/evidence/godot-mcp/mutation-journal.jsonl`. Records contain only hashed idempotency keys, canonical request digest, correlation ID, `started|completed`, action ID, plan digest, result summary, changes, partial effects, rollback, and timestamps. On open, read at most 4 MiB and retain the latest 256 unique key hashes; reject a larger or malformed ledger with a safe `CONFLICT` recovery message instead of truncating silently.

Use SHA-256 over `canonicalJson(input)` for the request digest and over the idempotency key for storage. Never store raw preimage bytes or raw idempotency keys.

- [ ] **Step 3: Upgrade audit/result plumbing for mutation facts**

Extend `ExecutedPayload` and `executeTool()` so handlers may return:

```ts
interface MutationExecutionFacts {
  warnings?: string[];
  changes?: unknown[];
  audit?: {
    targetIdentities: unknown[];
    preconditions: unknown[];
    idempotencyKeySha256: string | null;
    partialEffects: boolean;
    rollback: "not_needed" | "succeeded" | "failed" | "not_attempted";
  };
}
```

Add those fields to audit schema version 2 and give non-mutation callers explicit empty/default values in `JsonlAuditSink`. Update existing audit tests to expect schema version 2. Ensure `GodotMcpException` carries `failedPhase` and `safeRecovery` without including protected paths or stack traces.

- [ ] **Step 4: Write failing service tests for preview/apply/undo/redo**

Assert:

- preview dispatches `editor.mutate` without touching the ledger;
- apply recomputes the canonical request digest, begins the ledger before bridge dispatch, and completes it after a verified result;
- repeated completed apply returns the stored result with zero bridge calls;
- a `started` record returns `CONFLICT`, `partialEffects: true`, `rollback: not_attempted`, and directs the caller to preview/reconcile target revisions;
- bridge errors preserve `partialEffects` and `rollback` reported by Godot;
- result plan digest must match the preview/apply contract.

- [ ] **Step 5: Implement `EditorMutationService`**

Use this boundary:

```ts
export interface EditorMutationBridge {
  request<T>(method: "editor.mutate", params: unknown, options: {
    timeoutMs: number;
    maxResponseBytes: number;
    correlationId: string;
  }): Promise<{ requestId: string; data: T }>;
}

export class EditorMutationService {
  execute(input: EditorMutationInput, correlationId: string): Promise<EditorMutationResult>;
}
```

Preview uses a 10-second timeout. Apply/undo/redo use 30 seconds with the existing transport margin only. Validate the bridge response with `EditorMutationResultSchema` before completing the ledger. On an invalid or late result, leave the entry `started` so a retry cannot repeat an unknown mutation.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm exec vitest run packages/control-plane/src/editor packages/control-plane/src/audit packages/protocol/src/schemas.test.ts packages/mcp-server/src/executeTool.test.ts`

Expected: PASS.

```bash
git add packages/control-plane/src/editor packages/control-plane/src/audit packages/control-plane/src/errors.ts packages/control-plane/src/index.ts packages/protocol/src/schemas.ts packages/protocol/src/schemas.test.ts packages/mcp-server/src/executeTool.ts packages/mcp-server/src/executeTool.test.ts
git commit -m "feat: journal editor mutations"
```

## Task 3: Expose exactly one editor tool and explicit CLI grants

**Files:**
- Create: `packages/mcp-server/src/registerEditorTools.ts`
- Create: `packages/mcp-server/src/registerEditorTools.test.ts`
- Modify: `packages/mcp-server/src/createServer.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/cli/src/commands/connect.ts`
- Modify: `packages/cli/src/commands/connect.test.ts`
- Modify: `packages/cli/src/runtime/createRuntime.ts`
- Modify: `packages/cli/src/runtime/createRuntime.test.ts`

**Interfaces:**
- Consumes: `EDITOR_POLICY`, `EditorMutationInputSchema`, `EditorMutationService.execute()`.
- Produces: `registerEditorTools()` and CLI support for `--grant project_mutate --pack editor`.

- [ ] **Step 1: Write failing tool exposure tests**

Assert exact tool lists:

```ts
expect(await toolNames({ tiers: ["observe"], packs: ["core"] })).toHaveLength(6);
expect(await toolNames({ tiers: ["observe", "project_mutate"], packs: ["core", "editor"] })).toEqual([
  "godot_capabilities", "godot_capture", "godot_doctor", "godot_editor", "godot_help", "godot_query", "godot_session",
]);
expect(await toolNames({ tiers: ["observe", "project_mutate"], packs: ["core"] })).not.toContain("godot_editor");
expect(await toolNames({ tiers: ["observe"], packs: ["core", "editor"] })).not.toContain("godot_editor");
```

Call `godot_editor` once and assert destructive/non-repeat-safe annotations, schema validation before dispatch, `PERMISSION_REQUIRED` when invoked outside its policy, and audit arguments containing only the hashed idempotency key.

- [ ] **Step 2: Implement `registerEditorTools()`**

Register one tool:

```ts
server.registerTool("godot_editor", {
  title: "Mutate Godot editor content",
  description: "Preview, apply, undo, or redo one bounded transactional editor batch in an authenticated project.",
  inputSchema: EditorMutationInputSchema,
  outputSchema: ToolResultSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async (input) => toMcpToolResult(await executeTool(
  dependencies,
  EDITOR_POLICY,
  input,
  async (correlationId) => {
    const data = await dependencies.editor.execute(input, correlationId);
    return { data, warnings: data.warnings, changes: data.changes, audit: data.audit };
  },
  { auditArguments: summarizeEditorMutationForAudit(input) },
)));
```

- [ ] **Step 3: Gate server registration and wire runtime construction**

Add an optional `editor` controller to `GodotMcpServerDependencies`. Register only when the controller exists and grants contain `project_mutate` plus `editor`. In `createRuntime()`, construct the mutation ledger and service only for the editor grant; provide a bridge closure that requests `editor.mutate`.

- [ ] **Step 4: Extend CLI grant parsing without widening defaults**

Accept exactly:

```text
--grant runtime_control with runtime and/or input
--grant project_mutate with editor
```

`project_mutate` may coexist with `runtime_control`, but `editor` never appears implicitly. Normalize tiers to `observe`, then selected grants; normalize packs to `core`, then selected packs. Reject `project_mutate` without editor, editor without project_mutate, and every Phase 6+ pack/tier combination.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm exec vitest run packages/mcp-server/src packages/cli/src/commands/connect.test.ts packages/cli/src/runtime/createRuntime.test.ts`

Expected: PASS.

```bash
git add packages/mcp-server/src packages/cli/src/commands/connect.ts packages/cli/src/commands/connect.test.ts packages/cli/src/runtime/createRuntime.ts packages/cli/src/runtime/createRuntime.test.ts
git commit -m "feat: expose permission-scoped editor tool"
```

## Task 4: Build strict planning, target revisions, and Variant decoding in Godot

**Files:**
- Create: `addons/godot_mcp/mutation/editor_variant_decoder.gd`
- Create: `addons/godot_mcp/mutation/editor_mutation.gd`
- Create: `fixtures/godot-4.7/tests/editor_mutation_unit.gd`
- Modify: `addons/godot_mcp/plugin.gd`

**Interfaces:**
- Consumes: `EditorInterface`, `EditorUndoRedoManager`, `ClassDB`, `ResourceUID`, the existing `VariantEncoder`, and main-thread command queue.
- Produces: `GodotMcpEditorMutation.preview(arguments)`, `apply(arguments)`, `undo(arguments)`, and `redo(arguments)` through `execute(arguments)`.

- [ ] **Step 1: Write failing GDScript unit cases**

Use an isolated in-memory tree and fixture resources to assert:

```gdscript
var preview := mutation.execute({"operation": "preview", "steps": [{
	"operation": "set_property", "scenePath": "res://mutation/editor_mutation.tscn",
	"nodePath": "Target", "property": "position", "value": {"type": "vector2", "x": 12, "y": 34},
}]})
assert(preview.ok)
assert(preview.data.planDigest.length() == 64)
assert(target.position == Vector2.ZERO)
```

Also assert invalid classes, unknown script classes, absolute/traversing paths, subnames, property type mismatch, secret-like metadata, cross-scene batches, mixed scene/global history, 33 steps, more than 8 files, and preimages above 4 MiB all fail before effects.

- [ ] **Step 2: Implement typed Variant decoding**

`editor_variant_decoder.gd` accepts only the schema variants from Task 1. Decode arrays/dictionaries recursively with depth 8 and 256 members per container. Resolve `resource_ref` only after confirming the path is indexed by `EditorFileSystem`; load only that exact approved resource. Reject `NaN`, infinities, object IDs, callables, signals, RIDs, scripts, encoded objects, and unknown tagged types.

- [ ] **Step 3: Implement canonical target resolution and revisions**

For scene-object steps, find roots only in `EditorInterface.get_open_scene_roots()`. Resolve relative descendant `NodePath` values and reject nodes outside the root. Resolve engine classes through `ClassDB.class_exists()`, `ClassDB.can_instantiate()`, and required base class checks. Resolve project script classes only from `EditorFileSystem` metadata, never from caller-selected paths.

Compute each target revision as SHA-256 of canonical JSON containing persistent identity and bounded encoded state:

```text
project ID + scene UID/path + node path + class + owner path
storage properties + metadata + persistent groups + persistent signal connections
file existence + resource UID + file SHA-256 for scene/resource file targets
```

Sort property, metadata, group, and connection records before hashing. Redact secret-like names rather than incorporating secret values.

- [ ] **Step 4: Implement side-effect-free preview**

Preview validates every step, simulates path/name ownership changes in a lightweight plan model, determines the single required history, calculates preconditions and predicted changes, and returns:

```json
{
  "state": "previewed",
  "planDigest": "<sha256>",
  "history": { "kind": "scene", "scenePath": "res://mutation/editor_mutation.tscn" },
  "preconditions": [],
  "changes": [],
  "warnings": [],
  "audit": { "targetIdentities": [], "preconditions": [], "idempotencyKeySha256": null, "partialEffects": false, "rollback": "not_needed" }
}
```

The plan digest covers canonical steps, ordered target preimages, project identity, engine version, addon version, and bridge session generation. Apply must recompute it on the Godot main thread and return `CONFLICT` if it differs.

- [ ] **Step 5: Route `editor.mutate` through the existing main-thread queue**

Instantiate the adapter in `plugin.gd` with `get_editor_interface()`, `get_undo_redo()`, project root, and session-generation callback. Add only `editor.mutate` to `_execute_command`. Clear adapter state before bridge teardown. No mutation work may occur in the bridge polling callback.

- [ ] **Step 6: Run GDScript and protocol tests and commit**

Run:

```bash
pnpm build
tmp=$(mktemp -d)
cp -R fixtures/godot-4.7 "$tmp/project"
node packages/cli/dist/bin.js init --project "$tmp/project"
/opt/homebrew/bin/godot --headless --path "$tmp/project" --script res://tests/editor_mutation_unit.gd
rm -rf "$tmp"
```

Expected: build succeeds and Godot exits 0 after printing `GODOT_MCP_EDITOR_MUTATION_UNIT_OK`.

```bash
git add addons/godot_mcp/mutation addons/godot_mcp/plugin.gd fixtures/godot-4.7/tests/editor_mutation_unit.gd
git commit -m "feat: plan bounded editor mutations"
```

## Task 5: Implement native Undo/Redo scene and node mutations

**Files:**
- Modify: `addons/godot_mcp/mutation/editor_mutation.gd`
- Create: `addons/godot_mcp/mutation/editor_mutation_transaction.gd`
- Create: `fixtures/godot-4.7/mutation/editor_mutation.tscn`
- Create: `fixtures/godot-4.7/mutation/fixture_resource.tres`
- Modify: `fixtures/godot-4.7/tests/editor_mutation_unit.gd`

**Interfaces:**
- Consumes: the validated preview plan and decoded Variants from Task 4.
- Produces: one native action per apply and action-scoped undo/redo receipts.

- [ ] **Step 1: Extend failing units across every scene-object operation**

Build a fixture rooted at `Node2D` with `Target`, `Sibling`, `Container`, a declared signal, a group, metadata, and an assigned `.tres`. In one-operation and batch cases cover create/duplicate/move/rename/reparent/delete node, property, metadata, group, signal connection, owner, and resource reference assignment.

For each apply: preview, apply with its digest, assert postimage, undo and assert exact preimage digest, redo and assert exact postimage digest. Assert repeated apply/undo/redo with the same idempotency key returns the original result and does not change the history version.

- [ ] **Step 2: Implement transaction methods registered with `EditorUndoRedoManager`**

Use `create_action("Godot MCP <action-id>", UndoRedo.MERGE_DISABLE, scene_root, true, true)`. Register all do operations first, then undo operations in reverse dependency order. Use:

```text
add_do_method / add_undo_method for add_child, remove_child, reparent, move_child, names, metadata, groups, connections, owners
add_do_property / add_undo_property for validated property changes
add_do_reference for created/duplicated nodes
add_undo_reference for deleted nodes
```

The transaction keeps strong references to removed/created nodes until the action leaves history. Set `owner` for every persisted created descendant. Do not use `queue_free()` for an undoable deletion.

- [ ] **Step 3: Detect commit failures and roll back immediately**

Every registered do/undo helper records its first failure and makes later helpers no-op. After `commit_action()`, inspect the transaction error. If set, call `undo()` on the exact history returned by `get_object_history_id(scene_root)` / `get_history_undo_redo(id)`, verify the recomputed preimage digest, and return either:

```text
original stable error + partialEffects false + rollback succeeded
ROLLBACK_FAILED + partialEffects true + rollback failed + safe recovery
```

Do not clear user history. Track the action ID, history ID, before/after versions, and pre/post digests. Undo/redo must refuse unless the requested MCP action is currently on top and the history version matches; return `CONFLICT` instead of undoing a human editor action.

- [ ] **Step 4: Save and reload affected scenes**

After successful apply/undo/redo, make the mutated scene current only if it already is current, call `EditorInterface.save_scene()`, require `OK`, and wait for the editor filesystem scan/import state to settle within the command deadline. Reload the scene from its existing path in the integration lane and compare the same canonical revision.

- [ ] **Step 5: Run GDScript units and commit**

Run the Task 4 disposable-fixture command again.

Expected: `GODOT_MCP_EDITOR_MUTATION_UNIT_OK` and exit 0.

```bash
git add addons/godot_mcp/mutation fixtures/godot-4.7/mutation fixtures/godot-4.7/tests/editor_mutation_unit.gd
git commit -m "feat: mutate editor objects with native undo"
```

## Task 6: Add transactional scene/resource file operations

**Files:**
- Create: `addons/godot_mcp/mutation/project_file_transaction.gd`
- Modify: `addons/godot_mcp/mutation/editor_mutation.gd`
- Modify: `addons/godot_mcp/mutation/editor_mutation_transaction.gd`
- Modify: `fixtures/godot-4.7/tests/editor_mutation_unit.gd`

**Interfaces:**
- Consumes: validated global-history plans for scene/resource create, duplicate, move, and delete.
- Produces: atomic do/undo helpers with exact file preimages and resource cache/filesystem refresh.

- [ ] **Step 1: Add failing file-operation units**

For each scene/resource operation assert:

- preview makes no file change;
- apply creates/moves/deletes the exact expected `res://` files;
- `ResourceLoader.exists()` and `EditorFileSystem` reflect the new state;
- save/reload parses and instantiates scenes/resources;
- undo restores exact SHA-256 preimages and UIDs where supported;
- redo restores exact postimages;
- destination conflicts, changed preimages, symlink substitution, readonly destinations, and a forced second-step failure produce no silent partial success.

- [ ] **Step 2: Implement project-local path policy and preimage capture**

Globalize only already-validated `res://` paths, re-check canonical containment immediately before each effect, and reject protected regions. Open with no-follow semantics where available; otherwise compare nearest existing real parent before and immediately before rename. Capture bytes, mode, existence, SHA-256, resource UID, and cache state for at most 8 files / 4 MiB total.

- [ ] **Step 3: Implement atomic write, move, and delete helpers**

Write new bytes to a same-directory owner-only temporary file, flush and close, recheck the destination precondition, then rename atomically. Moves use a same-filesystem rename after both source and destination checks. Deletes rename to an owner-only transaction tombstone under `.godot/godot-mcp/mutation-journal/<action-id>/` until the action commits; undo renames it back. Remove tombstones only when it is safe to release the action preimage.

Create/duplicate scene files through `PackedScene.pack()` and `ResourceSaver.save()` to the transaction temp path. Create resources only for instantiable `Resource` subclasses. Explicitly reject scripts, shaders, imported assets, `PackedDataContainer`, and classes outside the Phase 5 resource allowlist; Phase 6 owns those authoring surfaces.

- [ ] **Step 4: Register file effects in global native history**

Use `EditorUndoRedoManager.GLOBAL_HISTORY` through `get_history_undo_redo(0)` and a custom transaction context. Register file do/undo methods, commit once, check the transaction error, and immediately undo on failure. Trigger the narrowest available `EditorFileSystem.update_file(path)` / `scan_sources()` refresh and wait for stable indexed state. Never call a broad project import unless the touched file type requires it.

- [ ] **Step 5: Run disposable units and commit**

Run the Task 4 disposable-fixture command.

Expected: all file operations, exact preimage restoration, and forced rollback cases pass.

```bash
git add addons/godot_mcp/mutation fixtures/godot-4.7/tests/editor_mutation_unit.gd
git commit -m "feat: transact scene and resource files"
```

## Task 7: Prove authenticated editor integration and hostile-input safety

**Files:**
- Create: `tests/integration/editor-mutation.test.ts`
- Create: `tests/security/editor-mutation-hostile.test.ts`
- Modify: `packages/bridge-client/src/bridgeSession.ts`
- Modify: `packages/bridge-client/src/bridgeSession.test.ts`
- Modify: `packages/protocol/src/editor.ts`
- Modify: `packages/protocol/src/editor.test.ts`

**Interfaces:**
- Consumes: authenticated `editor.mutate` bridge command and Phase 5 fixture.
- Produces: real-Godot proof for persistence, Undo/Redo, rollback, timeouts, disconnects, and hostile requests.

- [ ] **Step 1: Extend the bridge method allowlist and error payload**

Add only `editor.mutate` to `BridgeSession.request()`. Extend command errors to carry bounded `failedPhase`, `partialEffects`, `rollback`, and `safeRecovery`; keep message length ≤4096 and response JSON ≤512 KiB. Reject unknown fields and contradictory success/error payloads.

- [ ] **Step 2: Write real-editor success integration**

Launch a visible disposable editor with `res://mutation/editor_mutation.tscn`, attach using `{ tiers: ["observe", "project_mutate"], packs: ["core", "editor"] }`, then:

1. preview a representative 8-step single-scene batch and assert no diff;
2. apply with the returned digest and assert result/audit changes;
3. save, reload, and query the exact postimage;
4. undo and assert the exact preimage digest after reload;
5. redo and assert the exact postimage digest after reload;
6. close, disable, uninstall, and assert only the explicitly mutated fixture paths differ from the initial disposable copy;
7. restore through undo before cleanup and assert zero project diff.

- [ ] **Step 3: Write the hostile mutation matrix**

Cover missing grant/pack, method smuggling, absolute/file/traversal/subname paths, `.git`/`.env`/addon/unauthorized `.godot` targets, symlink escapes and substitution, unknown class names, script-path-as-class, arbitrary methods, scripts/shaders/imported resources, secret-like properties/metadata, nonfinite/deep/large Variants, 33 steps, 9 files, 4 MiB preimage overflow, cross-scene/mixed-history batches, duplicate destinations, stale preview digest, stale scene generation, changed file hash, reused idempotency key, expired deadline, late result, queue overflow, editor disconnect, malformed rollback fields, and injected failure after the first do method.

For every case assert the exact stable code, project diff, partial-effect flag, rollback outcome, no raw secrets/host paths in output or audit, and no tombstones after successful rollback.

- [ ] **Step 4: Run focused integration/security tests and commit**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm exec vitest run tests/integration/editor-mutation.test.ts tests/security/editor-mutation-hostile.test.ts packages/bridge-client/src/bridgeSession.test.ts packages/protocol/src/editor.test.ts
```

Expected: PASS on Godot `4.7.stable.official.5b4e0cb0f`.

```bash
git add tests/integration/editor-mutation.test.ts tests/security/editor-mutation-hostile.test.ts packages/bridge-client/src packages/protocol/src/editor.ts packages/protocol/src/editor.test.ts
git commit -m "test: verify editor mutation boundaries"
```

## Task 8: Certify the published stdio workflow and document Phase 5

**Files:**
- Create: `tests/end-to-end/phase-5.test.ts`
- Create: `scripts/qa-phase-5.mjs`
- Create: `docs/testing/phase-5.md`
- Modify: `docs/protocol/bridge-v1.md`
- Modify: `docs/security/threat-model.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: built CLI/server/addon packages and every prior phase gate.
- Produces: `pnpm qa:phase-5` and the Phase 5 certification record.

- [ ] **Step 1: Write the published stdio E2E test**

From a disposable fixture copy:

```ts
client = await launchMcpClient([
  "connect", "--project", project.root,
  "--grant", "project_mutate", "--pack", "editor",
]);
expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
  "godot_capabilities", "godot_capture", "godot_doctor", "godot_editor", "godot_help", "godot_query", "godot_session",
]);
```

Preview/apply a node creation, property change, group addition, signal connection, and resource assignment. Query the postimage, restart/reload the editor and query again, undo to the exact initial digest, redo to the exact postimage, then undo for cleanup. Assert completed idempotency replay after MCP restart returns the original receipt without a new Godot action. Verify audit JSONL contains hashed keys, target revisions, changes, and rollback fields but no raw property values marked sensitive.

- [ ] **Step 2: Add the Phase 5 gate**

`scripts/qa-phase-5.mjs` must pin macOS and exact Godot version, preserve redacted failure artifacts, and run these stages once:

```text
1 generated protocol drift
2 topological package builds
3 ESLint
4 TypeScript typecheck
5 package unit tests
6 disposable fixture import
7 GDScript mutation units
8 mutation contracts, ledger, MCP, and CLI tests
9 authenticated editor mutation integration
10 hostile mutation and rollback matrix
11 published stdio Phase 5 E2E
12 full regression suite
13 branch and working-tree diff checks
```

Add `"qa:phase-5": "node scripts/qa-phase-5.mjs"` to `package.json`. Add the Phase 5 gate to CI only in a macOS lane with a WindowServer-capable runner; keep non-Godot package checks on the existing runner.

- [ ] **Step 3: Update protocol, threat model, README, and certification docs**

Document:

- `editor.mutate` and the `godot_editor` tool;
- exact grants, operations, bounds, one-history batch rule, path/class policy, preview digest, idempotency behavior, audit fields, and recovery contract;
- native `EditorUndoRedoManager` semantics and the rule that MCP never undoes an intervening human action;
- direct-file atomic write/tombstone behavior and crash-left journal reconciliation;
- Phase 5 exclusions: script/shader authoring, imported assets, project settings/imports/builds/exports, runtime mutation, debugging, unsafe evaluation, shell, host filesystem, and network;
- the gate statement: save/reload persistence, exact Undo preimages, and failed-batch rollback or exact partial-effect reporting.

- [ ] **Step 4: Run focused documentation/config checks**

Run:

```bash
pnpm exec vitest run tests/end-to-end/phase-5.test.ts tests/meta/workspace.test.ts
pnpm lint
pnpm typecheck
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the certification slice**

```bash
git add tests/end-to-end/phase-5.test.ts scripts/qa-phase-5.mjs docs/testing/phase-5.md docs/protocol/bridge-v1.md docs/security/threat-model.md README.md package.json .github/workflows/ci.yml
git commit -m "test: certify Phase 5 editor mutation"
```

## Task 9: Run the Phase 5 gate and all required regressions

**Files:**
- Verify only; modify implementation/tests/docs only when a gate exposes a real Phase 5 defect.

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: evidence-backed Phase 5 completion with no skipped required gate.

- [ ] **Step 1: Run the Phase 5 certification gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-5`

Expected: `PASS (13/13 stages)` and no retained failure-artifact directory.

- [ ] **Step 2: Run the Phase 0–1 regression gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1`

Expected: PASS.

- [ ] **Step 3: Run the Phase 2 regression gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-2`

Expected: PASS with zero observation project diff.

- [ ] **Step 4: Run the Phase 3 regression gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-3`

Expected: PASS with no runtime process, descriptor, lease, or project diff.

- [ ] **Step 5: Run the Phase 4 regression gate**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-4`

Expected: PASS with held input neutralized and no runtime residue.

- [ ] **Step 6: Review final status and diff**

Run:

```bash
git status --short
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: only intentional Phase 5 files are present, diff check is clean, and commits correspond to the focused slices above.

## Plan Self-Review

- **Spec coverage:** Every Phase 5 roadmap item maps to Tasks 1 and 4–8; the gate maps to Tasks 7–9.
- **Security coverage:** Permission, path, class, Variant, history, conflict, idempotency, deadline, audit, rollback, and cleanup controls are explicit.
- **Boundary coverage:** Phase 6 authoring surfaces remain excluded; runtime/input behavior is unchanged.
- **Type consistency:** `EditorMutationService.execute(input, correlationId)` is the only MCP-facing control-plane interface; `editor.mutate` is the only added bridge method; `godot_editor` is the only added MCP tool.
- **Completion rule:** Phase 5 is not complete unless `qa:phase-5` and all four prior regression gates actually pass.

## References

- `docs/superpowers/specs/2026-07-15-godot-mcp-master-design.md`
- `docs/security/threat-model.md`
- `docs/protocol/bridge-v1.md`
- `docs/testing/phase-4.md`
- Godot 4.7 `EditorUndoRedoManager`: <https://docs.godotengine.org/en/4.7/classes/class_editorundoredomanager.html>
- Godot 4.7 `EditorInterface`: <https://docs.godotengine.org/en/4.7/classes/class_editorinterface.html>
- Godot 4.7 command-line operations: <https://docs.godotengine.org/en/4.7/tutorials/editor/command_line_tutorial.html>
