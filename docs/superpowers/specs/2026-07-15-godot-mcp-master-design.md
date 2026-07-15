# Godot MCP Master Design

- **Date:** 2026-07-15
- **Status:** Approved master design
- **Initial platform:** macOS on Apple Silicon
- **Initial engine:** Godot 4.7
- **Initial MCP client:** Codex
- **Distribution:** Fully open-source monorepo

## 1. Purpose

Build a reusable, production-grade Godot MCP that can observe and control the Godot editor and instrumented game runs, author project content, debug and test projects, automate input, capture visual evidence, and orchestrate project operations without exposing an unauthenticated or unrestricted Godot control surface.

The product is a standalone repository. It installs a pinned editor addon into a selected Godot project, but it is not owned by or permanently embedded in any one game repository.

“Complete” means a deliberate automation surface covering the supported Godot workflows in this document. It does not mean blindly exposing every engine method or allowing arbitrary code execution by default.

## 2. Approved product decisions

- Use a dedicated disposable Godot fixture for destructive, crash, hostile-input, unsafe-mode, and export-leakage testing.
- Use `/Users/tony/Projects/town-building-game` only as a realistic acceptance harness, preferably through an isolated copy or clean worktree.
- Validate on macOS first while preserving cross-platform interfaces for later Windows and Linux certification.
- Implement against Godot 4.7 first, then certify Godot 4.4 through 4.6.
- Optimize the first release for Codex while remaining compliant with the standard MCP protocol.
- Distribute the server, CLI, protocol, addon, fixtures, and documentation as a fully open-source monorepo.
- Use a CLI-managed, pinned, reversible project addon installation.
- Use an authenticated hybrid architecture: MCP over stdio, then an authenticated loopback bridge to a Godot EditorPlugin.
- Do not use a permanent runtime autoload.
- Do not expose arbitrary GDScript in normal permission profiles.
- Permit arbitrary GDScript only in an explicitly enabled, fixture-only unsafe mode. This mode is not presented as a secure sandbox.
- Keep the default MCP tool surface small and expose additional capability packs only when granted.
- Require typed validation, project containment, audit receipts, cleanup evidence, and export-leakage tests throughout the product.

## 3. Goals

The completed product supports:

- Editor and running-game screenshots as real MCP image content.
- Multi-frame capture, visual comparison, and deterministic evidence artifacts.
- Mouse, keyboard, action, touch, multitouch, drag, pan, pinch, scroll, gesture, and gamepad automation.
- Scene, node, property, resource, script, shader, signal, group, animation, UI, theme, audio, physics, navigation, import, and project-setting workflows.
- Native editor Undo/Redo for editor-object mutations.
- Transactional and conflict-aware direct-file mutations when an editor API is not appropriate.
- Runtime scene-tree and property inspection, monitoring, logging, errors, deterministic waits, pause, resume, and frame stepping.
- Debugger sessions, breakpoints, stacks, variables, performance metrics, and profiler evidence.
- Declarative playtest scenarios, assertions, input replay, visual regression, and QA receipts.
- Import, run, build, and export orchestration with cancellable jobs.
- Versioned capability discovery and a small permission-scoped tool surface.
- Crash recovery, stale-session cleanup, and proof that release artifacts contain no MCP runtime bridge.

## 4. Non-goals and hard boundaries

- The MCP does not replace human usability testing, aesthetic judgment, accessibility review by affected users, or physical-device evidence.
- The MCP does not provide arbitrary host filesystem, shell, terminal, process, or network tools.
- The normal tool surface does not provide `eval`, arbitrary method invocation, arbitrary resource-path loading, or unvalidated class instantiation.
- Loopback binding is not treated as authentication.
- MCP tool annotations are not treated as authorization.
- Unsafe fixture mode cannot safely sandbox hostile code that runs as the current OS user. It therefore runs only against disposable, explicitly trusted fixture copies with a scrubbed environment and prominent warnings.
- A process that has already compromised the current OS user can read that user’s runtime files or instrument their processes. Pairing prevents unauthenticated network and ordinary local clients from controlling Godot; it is not a security boundary against full same-user host compromise.
- Cross-platform support is not claimed until the platform-specific certification lane passes.
- Godot 4.4 through 4.6 support is not claimed until the version-specific certification lane passes.

## 5. Architecture

```text
Codex or another MCP host
          |
          | MCP over stdio
          v
TypeScript MCP server
          |
          +-- schema and protocol adapter
          +-- policy and permission gateway
          +-- sessions, jobs, audit, and evidence
          +-- project and process lifecycle
          |
          | authenticated JSON-RPC over loopback WebSocket
          v
Godot EditorPlugin
          |
          +-- EditorInterface and editor viewports
          +-- EditorUndoRedoManager
          +-- EditorDebuggerPlugin
          +-- editor adapters and main-thread queue
          |
          +-- ephemeral instrumented runtime instance
                  |
                  +-- scene and property inspection
                  +-- screenshots and frame capture
                  +-- input injection and replay
                  +-- waits, assertions, logs, and metrics
```

### 5.1 Control plane ownership

The TypeScript control plane is the only path from an MCP request to Godot. It owns:

- Public schema validation.
- Project identity and path containment.
- Permission enforcement.
- Request deadlines, quotas, and cancellation.
- Idempotency and mutation preconditions.
- Process ownership and lifecycle.
- Evidence storage and audit receipts.
- Protocol and package compatibility checks.

The MCP adapter contains no Godot business logic. Godot adapters do not make authorization decisions.

### 5.2 Editor addon

The CLI installs an exact addon release under `res://addons/godot_mcp`. The addon is a `@tool` `EditorPlugin` and contains focused adapters rather than one large command router.

All SceneTree and editor-object operations execute on Godot’s main thread through a bounded queue. Transport polling and payload decoding may run independently, but they may not directly mutate or inspect non-thread-safe editor objects.

The addon:

- Initiates the bridge connection.
- Captures 2D and 3D editor viewports.
- Reads editor state and project metadata.
- Performs editor-object changes through `EditorUndoRedoManager`.
- Registers and unregisters debugger integration.
- Reports lifecycle and cleanup state.
- Refuses incompatible server or protocol versions.

### 5.3 Instrumented runtime

Runtime automation starts a dedicated Godot debug process for a requested scene. The installed addon contains the version-pinned runtime harness source, but the harness is instantiated only for an MCP-controlled run.

The MCP launches the harness scene with Godot’s scene-specific command-line support and passes non-secret run parameters after the engine argument separator. The harness loads the requested project scene, establishes the debugger/bridge channel, and then installs its instrumentation node outside the game’s owned scene subtree. It sets the requested scene as the current scene and records the instrumentation node explicitly so queries can exclude it by default.

The runtime opens no command listener. It communicates through Godot’s debugger channel to the registered `EditorDebuggerPlugin`. Before launch, the control plane creates a runtime-only secret in an owner-readable temporary descriptor and passes only that descriptor’s path to the owned process. The harness consumes and invalidates the descriptor, then proves possession in its first debugger message. The editor plugin binds the debugger session to the expected project, PID launch fingerprint, and MCP session before accepting runtime commands.

This design:

- Does not add an autoload.
- Does not change the project’s configured main scene.
- Does not require a persistent `project.godot` mutation.
- Allows a controlled debug process to be stopped and recovered independently.
- Requires parity tests because an instrumented run contains one reserved instrumentation node.

Release exports exclude the addon and are scanned to prove exclusion. A project that deliberately exports all resources must use the CLI-managed export exclusion or fail the export-safety gate.

## 6. Repository structure

```text
godot-mcp/
├── packages/
│   ├── protocol/        Shared RPC types, schemas, versions
│   ├── mcp-server/      MCP stdio adapter and tool packs
│   ├── control-plane/   Policy, sessions, jobs, audit, evidence
│   ├── bridge-client/   Authenticated Godot communication
│   ├── cli/             init/connect/doctor/disable/uninstall
│   └── testkit/         Fixtures, scenarios, assertions, visual diff
├── addons/
│   └── godot_mcp/       Project-installed EditorPlugin and runtime harness
├── fixtures/
│   ├── godot-4.7/       Disposable acceptance project
│   └── hostile/         Security and malformed-project fixtures
├── tests/
│   ├── integration/
│   ├── end-to-end/
│   ├── security/
│   └── compatibility/
└── docs/
```

The TypeScript workspace targets Node.js 22, uses pnpm workspaces, strict TypeScript, Zod-compatible runtime schemas, and Vitest. Published packages run on standard Node.js; Bun may be used as an optional local runner but is not a runtime requirement.

One product SemVer release pins all packages and the addon. The bridge protocol also has an explicit compatibility version. Release automation rejects mixed package versions.

## 7. Attachment, pairing, and authentication

### 7.1 CLI-managed lifecycle

The CLI provides:

- `godot-mcp init <project>`
- `godot-mcp connect <project>`
- `godot-mcp doctor <project>`
- `godot-mcp disable <project>`
- `godot-mcp uninstall <project>`

`init` validates the project, installs a pinned addon, records non-secret project-local metadata, and reports every file changed. `uninstall` removes only files whose installed hashes still match or requires an explicit conflict resolution.

### 7.2 Pairing

The server binds a randomly selected loopback port and writes a short-lived descriptor into the OS runtime directory. The descriptor is owner-readable only and contains:

- Port and transport version.
- Session nonce.
- One-use 256-bit pairing token.
- Canonical project identity.
- Expiry time.

The addon locates the descriptor for its canonical project identity, connects outward, and authenticates before any command is accepted. Successful pairing deletes or invalidates the one-use token and derives a session key. Request envelopes include a session identifier, monotonic sequence number, deadline, and integrity code. Replayed, reordered, expired, or cross-project envelopes are rejected.

Pairing also verifies:

- Product and protocol versions.
- Addon manifest hash.
- Canonical project path.
- `project.godot` fingerprint.
- Engine version and feature tags.
- Requested and granted capability packs.

### 7.3 Limits

- Loopback only; no wildcard bind.
- No port-range scanning.
- Bounded message and binary-frame sizes.
- Bounded request concurrency and job queues.
- Deadlines on every request.
- Rate and evidence-volume limits.
- Explicit image dimensions and frame-count limits.
- Immediate session revocation on project or addon identity drift.

## 8. Permissions

Permissions are cumulative but granted independently.

### 8.1 `observe`

Default tier. It permits editor/runtime reads, logs, metrics, screenshots, capability discovery, health checks, and evidence retrieval.

### 8.2 `runtime_control`

Permits instrumented process lifecycle, input, pause, frame stepping, replay, and ephemeral runtime property changes. It does not permit project-file changes.

### 8.3 `project_mutate`

Permits Undo/Redo-backed editor changes and transactional project-file changes inside approved project paths.

### 8.4 `project_operate`

Permits import, reimport, plugin state, project settings, builds, and exports. It is explicitly enabled per session.

### 8.5 `unsafe_fixture`

Requires all of the following:

- A server startup flag.
- A canonical path previously registered outside MCP as an unsafe fixture root.
- A fixture identity marker matching that registration.
- A disposable fixture copy rather than an irreplaceable project checkout.
- A second interactive approval.
- A short expiry and automatic revocation.

Unsafe execution runs in a separate Godot process with a scrubbed environment, temporary home and user-data locations where supported, time and output limits, and no inherited credentials. These controls reduce accidental exposure but do not make arbitrary GDScript a secure sandbox.

MCP annotations declare read-only, destructive, and repeat-safe behavior for host UX. The control plane enforces permissions regardless of annotations or client behavior.

## 9. Mutation and filesystem safety

- Canonicalize and resolve all paths before authorization.
- Restrict project operations to approved `res://` regions.
- Reject symlink escapes and post-validation path substitution.
- Deny `.git`, environment files, credentials, OS configuration, and arbitrary host paths.
- Provide no general shell or process-execution tool.
- Use atomic temporary-file writes followed by rename.
- Record preimage hashes and reject unexpected concurrent changes.
- Journal multi-step operations and retain rollback preimages until commit.
- Use `EditorUndoRedoManager` for editor-object changes.
- Group one logical batch into one Undo/Redo action.
- Validate engine classes with Godot class metadata.
- Resolve project script classes only through an explicit project-class registry.
- Never treat an unknown class name as a resource path.
- Never load or instantiate an arbitrary path supplied where a class name is expected.
- Return partial-effect and rollback status for every failed mutation.

Persistent targets use project identity, resource UID or canonical path, scene UID, `NodePath`, and an expected revision or preimage hash. Ephemeral editor and runtime handles also contain a session generation so handles from an old run fail as stale.

## 10. Tool model

### 10.1 Stable core

The always-loaded surface is intentionally small:

- `godot_session`
- `godot_capabilities`
- `godot_doctor`
- `godot_query`
- `godot_capture`
- `godot_job`
- `godot_evidence`
- `godot_help`

### 10.2 Capability packs

Authorization may expose additional cohesive packs:

- `runtime`: launch, stop, wait, inspect, and control.
- `input`: send events and sequences, record, and replay.
- `editor`: transactional scenes, nodes, resources, properties, signals, groups, Undo, and Redo.
- `debug`: breakpoints, execution control, stacks, variables, watches, and profiling.
- `visual`: baselines, comparisons, masks, tolerances, and frame series.
- `project`: imports, plugin state, settings, builds, and exports.
- `unsafe`: fixture-only arbitrary evaluation.

Each pack exposes a few cohesive tools with typed operation variants. It does not expose one MCP tool per Godot method. Large operation-specific schemas and examples are retrieved through `godot_help` only when required.

Tool-list changes occur only when external authorization or attachment state changes, never as a hidden side effect of an ordinary tool call.

### 10.3 Resources and images

Large scene trees, logs, profiler captures, reports, and stored evidence return MCP resource links. Screenshots return real MCP image content and may additionally be persisted into the session evidence store.

Evidence resources are content-addressed, bounded, session-scoped by default, and never accept caller-chosen arbitrary host paths.

## 11. Request and data flow

1. The MCP host calls a tool through stdio.
2. The MCP adapter validates the public input schema.
3. The control plane resolves session, project, target identity, and capability pack.
4. Policy verifies permission, canonical paths, fingerprints, preconditions, deadlines, quotas, and idempotency.
5. A quick operation executes immediately; a long operation returns a cancellable job handle.
6. The authenticated bridge sends a versioned command envelope to Godot.
7. Godot queues the command onto its main thread.
8. A focused adapter performs the operation and gathers warnings, evidence, changes, and rollback state.
9. The control plane normalizes the result, stores large evidence, and appends an audit receipt.
10. The MCP adapter returns structured content, image content, or resource links.

Mutating requests accept an idempotency key. Repeating a completed request returns the original receipt instead of repeating the mutation. A retry after an unknown outcome must first reconcile the prior audit and target revision.

## 12. Jobs and cancellation

Imports, frame sequences, playtest scenarios, profiler captures, builds, and exports run as jobs.

A job contains:

- Job and correlation identifiers.
- Owning session and project identity.
- State, phase, progress, and deadline.
- Cancellation capability and current cancellation safety.
- Child process identities.
- Partial effects and rollback state.
- Evidence and audit references.

Cancellation is cooperative first, then escalates only against processes whose PID and launch fingerprint prove ownership. Broad process-name termination is forbidden.

## 13. Result and error contract

Successful operations return:

```json
{
  "ok": true,
  "data": {},
  "warnings": [],
  "evidence": [],
  "changes": [],
  "auditId": "audit_...",
  "correlationId": "req_..."
}
```

Long-running operations also return job state and cancellation metadata.

Errors contain:

- Stable code and human-readable message.
- Correlation identifier and failed phase.
- Retryability.
- Partial-effect status.
- Rollback attempt and outcome.
- Safe recovery action.
- Protected evidence reference when detailed logs exist.

Required stable codes include:

- `NOT_ATTACHED`
- `AUTHENTICATION_FAILED`
- `PERMISSION_REQUIRED`
- `VERSION_MISMATCH`
- `PROJECT_CHANGED`
- `PATH_DENIED`
- `TARGET_NOT_FOUND`
- `STALE_HANDLE`
- `PRECONDITION_FAILED`
- `CONFLICT`
- `TIMEOUT`
- `CANCELLED`
- `GODOT_PARSE_ERROR`
- `GODOT_RUNTIME_ERROR`
- `ASSERTION_FAILED`
- `ROLLBACK_FAILED`
- `EXPORT_LEAK_DETECTED`

Raw stack traces, secrets, and sensitive host paths remain in protected evidence rather than appearing automatically in model context.

## 14. Audit and evidence

The initial audit store is append-only JSONL with a stable schema suitable for later SQLite indexing. Each record includes:

- Session, project identity, tool, permission tier, and protocol version.
- Start, finish, duration, outcome, and stable error code.
- Normalized arguments with secret-like and sensitive fields redacted.
- Target identities, preconditions, and idempotency key hash.
- Changed files or objects and their pre/post hashes.
- Owned process identities.
- Evidence references.
- Partial-effect and rollback status.
- Correlation identifier spanning MCP, control plane, editor, runtime, and test events.

Evidence includes screenshots, frame series, diffs, logs, profiles, build reports, export scans, and deterministic QA receipts. Every artifact records the exact product, addon, protocol, Godot, platform, renderer, project revision, and test configuration used.

## 15. Crash recovery and cleanup

- Runtime automation creates no autoload and no persistent main-scene or `project.godot` change.
- The server journals installed files, active sessions, jobs, transactions, owned processes, and temporary evidence.
- `doctor` detects expired descriptors, dead connections, orphaned owned processes, incomplete transactions, modified addon files, and version drift.
- Recovery terminates only processes with matching PID, launch fingerprint, session, and project identity.
- Interrupted file mutations are either not committed or recoverable from retained preimages.
- Editor plugin exit unregisters debugger hooks, docks, callbacks, queues, and connections.
- Addon uninstall removes only unchanged installed files and reports user-modified conflicts.
- Cleanup is idempotent and safe to run repeatedly.

## 16. Export safety

- Release export tools refuse to run while unsafe or instrumented runtime sessions are active.
- CLI-managed export configuration excludes `addons/godot_mcp/**` when the preset could otherwise include it.
- The export gate scans PCK, ZIP, and unpacked artifacts for addon paths, bridge scripts, protocol markers, tokens, unsafe code, and known instrumentation symbols.
- Any detected MCP component fails with `EXPORT_LEAK_DETECTED`.
- The exported fixture must launch and pass a smoke scenario without an MCP server.
- Export safety tests cover normal shutdown, crashed editor, crashed server, stale addon state, and “export all resources” presets.

## 17. Testing strategy

### 17.1 Targets

- `fixtures/godot-4.7`: disposable 2D, 3D, Control, animation, audio, physics, navigation, resource, import, error, and export coverage.
- `fixtures/hostile`: traversal, symlink, malformed project, oversized data, invalid schema, crash, and malicious script cases.
- `town-building-game`: realistic acceptance through an isolated copy or clean worktree, with pre/post hashes and git state proving the source checkout was not changed.

### 17.2 Layers

1. TypeScript and GDScript unit tests.
2. Cross-language protocol fixture tests.
3. Real-editor integration tests.
4. Instrumented runtime integration tests.
5. Published stdio MCP end-to-end tests.
6. Security, fuzz, concurrency, timeout, and crash tests.
7. Deterministic screenshot and scenario tests.
8. Release export and artifact-scan tests.

Deterministic visual tests pin viewport size, renderer, locale, seed, time step, fixture assets, and comparison settings. Deterministic CI evidence remains separate from human visual acceptance.

## 18. Phased delivery roadmap

Each phase ends with code, tests, documentation, failure-path coverage, cleanup proof, and a runnable acceptance gate. A later phase may not weaken an earlier security invariant.

### Phase 0: Foundation and contracts

- Initialize workspace packages and strict build/test tooling.
- Define protocol, result, error, capability, audit, and evidence schemas.
- Generate shared protocol fixtures and GDScript version constants.
- Build disposable and hostile fixtures.
- Establish threat model, CI, version synchronization, and release manifests.

**Gate:** workspace checks pass; the fixture imports and runs; generated schemas and fixtures match committed outputs.

### Phase 1: Secure attachment

- Implement CLI lifecycle commands.
- Implement project identity, descriptor, pairing, handshake, session, and replay protection.
- Implement permission and capability primitives.
- Implement append-only audit receipts.
- Expose read-only session, capability, doctor, and help tools.

**Gate:** valid pairing works; unauthorized, replayed, expired, incompatible, and wrong-project clients fail without side effects.

### Phase 2: Editor observation

- Project and editor state.
- Open scenes, selections, trees, nodes, resources, scripts, signals, groups, settings, imports, output, warnings, and errors.
- Real 2D and 3D editor viewport images.

**Gate:** structured reads match fixture truth; viewport captures are valid, nonblank images; observation leaves no project diff.

### Phase 3: Ephemeral runtime bridge

- Instrumented scene launch and lifecycle.
- Runtime tree, properties, signals, logs, errors, waits, pause, resume, and frame stepping.
- Running-game screenshot and multi-frame capture.

**Gate:** runtime inspection and images match fixture truth; shutdown leaves no project diff, stale descriptor, or owned process; parity tests quantify the instrumentation node’s effect.

### Phase 4: Input automation

- Mouse, keyboard, actions, touch, multitouch, drag, pan, pinch, scroll, gestures, and gamepad.
- Embedded and stretched viewport coordinate transforms.
- Sequences, recording, deterministic replay, and input receipts.

**Gate:** every supported input produces an asserted state change; recorded replay reproduces the same state under pinned conditions.

### Phase 5: Editor mutation

- Create, duplicate, move, rename, reparent, and delete scenes and nodes.
- Properties, metadata, groups, signals, owners, and resources.
- Native Undo/Redo, dry runs, batches, conflict detection, journaling, and rollback.

**Gate:** mutations survive save/reload; Undo restores exact preimages; failed batches roll back or report exact partial effects.

### Phase 6: Complete authoring surface

- Constrained script and shader file workflows.
- UI, themes, animations, AnimationTree, audio, physics, navigation, TileMap, particles, materials, meshes, textures, imports, and custom resources.
- Typed operations where stable and introspection-driven property operations where breadth is required.

**Gate:** supported authoring operations produce parseable, importable, reference-valid resources and pass focused fixture behavior checks.

### Phase 7: Debugging and performance

- Debug sessions, breakpoints, execution control, stacks, variables, watches, and remote objects.
- CPU, GPU, memory, frame, monitor, and profiler evidence.
- Cancellable long-running captures.

**Gate:** deliberate fixture errors, breakpoints, stacks, variables, and profiles produce correct structured evidence and clean recovery.

### Phase 8: Testing and visual QA

- Declarative scenarios, assertions, eventual conditions, and reports.
- Screenshot baselines, masks, tolerances, regions, comparisons, multi-frame evidence, and visual-regression receipts.
- Initial isolated `town-building-game` realistic acceptance.

**Gate:** scenarios repeat under pinned conditions; intentional behavior and visual changes fail with useful evidence; the source acceptance checkout remains unchanged.

### Phase 9: Project and build operations

- Import, reimport, plugin state, project settings, run, build, and export.
- Cancellable jobs, artifact management, process cleanup, and crash recovery.
- Release-artifact leakage detection.

**Gate:** operations are cancellable and recoverable; fixture release exports contain zero MCP components and run without the MCP server.

### Phase 10: Unsafe fixture mode and extensions

- Fixture registration and second-factor enablement.
- Separate unsafe process, scrubbed environment, limits, expiry, and audit.
- Extension SDK for project-specific typed capabilities.

**Gate:** unsafe execution is unreachable in normal projects, expires automatically, and is visibly identified as non-sandboxed; extensions cannot bypass the control plane.

### Phase 11: Compatibility and public release

- Godot 4.4 through 4.6 certification after the 4.7 baseline.
- Windows and Linux process and transport certification after macOS.
- Fuzzing, hostile clients, concurrency, stale sessions, upgrade, rollback, and package-integrity testing.
- Synchronized npm, GitHub, and Godot Asset Library releases.

**Gate:** each advertised engine/platform matrix cell passes the required suite; release artifacts share one manifest and version; install, upgrade, rollback, and uninstall are independently verified.

## 19. Acceptance principles

- A happy path alone cannot complete a phase.
- Required failure, authorization, cancellation, cleanup, and evidence checks must pass.
- Skipped checks are reported as skipped and never implied to have passed.
- A current source-of-truth check precedes claims about editor, runtime, project, process, or export state.
- Realistic acceptance does not authorize mutation of the source game checkout.
- Tool breadth is added only through typed, permissioned adapters and may not bypass the control plane.
- New Godot versions, platforms, or clients are “experimental” until their certification lane passes.

## 20. Implementation planning boundary

This master design establishes the product architecture, invariants, complete phase map, and completion gates. It is intentionally not a single implementation batch.

The first implementation plan will cover Phase 0 and Phase 1 only: foundation, shared contracts, fixtures, CLI lifecycle skeleton, secure pairing, permissions, capability discovery, and audit receipts. Each later phase receives a focused implementation plan that inherits this master design and may refine internal details without weakening its approved security and compatibility boundaries.

## 21. Primary technical references

- Godot 4.7 command-line scene launch and export operations: <https://docs.godotengine.org/en/4.7/tutorials/editor/command_line_tutorial.html>
- Godot editor plugin lifecycle: <https://docs.godotengine.org/en/stable/tutorials/plugins/editor/making_plugins.html>
- Godot `EditorDebuggerPlugin`: <https://docs.godotengine.org/en/latest/classes/class_editordebuggerplugin.html>
- Godot 4.7 `EditorUndoRedoManager`: <https://docs.godotengine.org/en/4.7/classes/class_editorundoredomanager.html>
- Godot 4.7 `EditorInterface`: <https://docs.godotengine.org/en/4.7/classes/class_editorinterface.html>
- Godot 4.7 `EngineDebugger`: <https://docs.godotengine.org/en/4.7/classes/class_enginedebugger.html>
- MCP tools and host security guidance: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- MCP schema reference: <https://modelcontextprotocol.io/specification/2025-11-25/schema>
