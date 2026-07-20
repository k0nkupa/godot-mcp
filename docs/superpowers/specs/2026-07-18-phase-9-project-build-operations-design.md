# Phase 9 Project and Build Operations Design

- **Date:** 2026-07-18
- **Status:** Approved under the standing phase auto-approval instruction
- **Scope:** Phase 9 only

## Outcome

Phase 9 adds one explicitly granted `godot_project` tool. It owns bounded project-operation jobs for import/reimport, ordinary project runs, scripting-solution builds, and exports; typed project-setting and editor-plugin changes; artifact custody; cancellation/recovery; and release-export leakage detection.

The tool requires the already reserved `project_operate` tier and `project` capability pack. It is never implied by `project_mutate`, `runtime_control`, or any existing pack. Default sessions remain six tools. Adding `project` adds exactly one tool and does not implicitly expose runtime, input, editor, visual, or unsafe capabilities.

## Security boundary

Phase 9 does not add a shell, arbitrary executable, caller-selected host path, arbitrary environment, arbitrary Godot argument, arbitrary script, or network primitive. Every child process is the configured Godot 4.7 binary with arguments selected from a closed operation enum. Project identity is rechecked before each operation.

All artifacts live under:

```text
<project>/.godot/evidence/godot-mcp/artifacts/<opaque-job-token>/
```

Callers choose only a safe artifact label, export preset name, and closed export mode; they never choose a host path. Public receipts expose content digests and `godot-mcp://artifact/...` URIs, not filesystem paths.

Owned processes use exact PID plus launch fingerprint ownership. Cancellation sends a cooperative interrupt, waits a bounded grace period, and escalates only against that exact owned process. Process-name killing is forbidden. Environment construction starts from a small runtime/toolchain allowlist and removes credential, proxy-credential, cloud, package-token, SSH-agent, and MCP/session variables.

## Public operations

`godot_project` accepts these strict operations:

- `settings_apply`: up to 32 primitive setting changes with expected preimages and one idempotency key. Names must be in a documented safe namespace, while executable, network, credential, editor-plugin, autoload, native-extension, filesystem-root, and import-side-effect settings are denied. Resource values must be canonical `res://` paths.
- `plugin_set`: enable or disable one existing `res://addons/<safe-name>/plugin.cfg` with an expected current state and idempotency key. The Godot MCP addon itself cannot be changed through MCP; CLI lifecycle remains its only owner.
- `import_start`: start either a full editor import or a bounded reimport list of at most 128 canonical project resources. Reimport uses the attached editor's `EditorFileSystem`; it reports when cancellation is temporarily unsafe during Godot's importer call.
- `run_start`: start the project main scene or one validated project scene, optionally headless, for at most 120 seconds. No caller arguments are accepted.
- `build_start`: run Godot's fixed `--build-solutions` operation for a project that declares a supported scripting solution.
- `export_start`: export `release`, `debug`, or `pack` from one existing preset into the owned artifact directory. Export refuses while an MCP-owned runtime, visual scenario, unsafe job, or another project job is active.
- `job_status`, `job_cancel`, and `job_result`: address one opaque, session/project-bound job token.

Imports, reimports, runs, builds, and exports are jobs. Settings and plugin mutations are short transactional operations with preimage hashes, postimage hashes, exact changes, rollback receipts, and idempotent replay.

## Project mutation adapter

The attached addon receives only `project.settings_apply`, `project.plugin_set`, and `project.reimport` messages. It runs them on the editor main thread through the existing bounded queue.

Settings and plugin state are saved through `ProjectSettings` using a retained preimage. A save or postcondition failure restores the preimage and saves again. Reimport validates every resource path, snapshots importer metadata, invokes only `EditorFileSystem.reimport_files`, waits for the filesystem to settle, and returns before/after importer identities and errors. It never accepts an importer executable or arbitrary option blob.

Disabling a plugin that is currently executing is deferred to a fresh owned editor helper process; the attached addon never unloads itself or another plugin mid-callback.

## Job model

Only one project job may be active per server/project. A job has:

- 256-bit opaque token bound to session and project identity;
- operation, state, phase, progress, deadline, and cancellation-safety flag;
- owned PID/fingerprint when a process exists;
- canonical start/finish times and exit status;
- bounded stdout/stderr summaries stored as protected evidence;
- artifact manifest and leakage scan for exports;
- partial-effects and recovery receipt.

Terminal state is `completed`, `failed`, or `cancelled`. A server restart recovers journaled nonterminal jobs by verifying process identity, terminating only a still-owned child, scanning any artifact residue, and writing a terminal recovery receipt. A mismatched/reused PID is never signalled.

## Import and run execution

Full import uses exactly:

```text
godot --headless --editor --path <project> --import
```

Build uses exactly `--headless --path <project> --build-solutions --quit`. A project run uses `--path <project>` plus an optional validated `--scene res://...`; headless adds only `--headless`. The job deadline supplies termination rather than caller engine flags.

Reimport uses the authenticated editor adapter because Godot 4.7 exposes selective reimport there, not as a closed CLI flag. Cancellation is accepted immediately while queued/waiting and becomes pending during the non-interruptible main-thread importer call; the receipt exposes this honestly.

## Export safety

An export starts only when:

- the selected preset exists and matches the requested mode;
- its effective resource filters exclude `addons/godot_mcp/**`;
- no conflicting owned runtime/job exists;
- its output is the new empty owned artifact directory;
- project and addon identities still match the attached session.

After Godot exits successfully, the scanner walks only the owned artifact root, rejects symlinks and special files, caps entries and total bytes, and streams every file while detecting markers across chunk boundaries. It searches paths and bytes for addon paths, bridge/runtime scripts, `godot-mcp://`, protocol markers, descriptor/token field names in MCP-specific combinations, unsafe fixture code, and known instrumentation class names. ZIP/PCK central metadata and raw bytes are both covered; unpacked bundles are traversed directly.

Any marker produces `EXPORT_LEAK_DETECTED`, retains protected scan evidence, and makes the artifact unavailable for release use. Passing artifacts get a canonical manifest of relative path, length, and SHA-256. The fixture release export must then launch without an MCP server and emit a dedicated smoke marker. The scan is a release gate, not a claim that arbitrary user secrets were audited.

## Audit and redaction

Audit includes operation, hashed preset/plugin/setting identities, counts, modes, job state, owned-process identity, artifact digests, scan result, partial-effects, and rollback status. It excludes setting values, resource contents, raw logs, environment values, filesystem paths, export bytes, and job tokens.

## Bounds

- one active project job;
- 32 setting changes;
- 128 reimport paths;
- 120-second import/run/build deadline and 300-second export deadline;
- 4 MiB combined retained process output;
- 10,000 artifact entries and 4 GiB scanned bytes;
- 256 MiB per artifact file for in-memory metadata work; file hashing/scanning is streaming;
- 64 leakage findings in public/protected receipts.

## Acceptance and gate

The disposable fixture contains an import target, a safe export preset, and a release smoke scene. Tests cover authorization, strict schemas, setting/plugin rollback, selective reimport, cancellation at every safe phase, PID reuse, crash recovery, artifact containment, symlinks, oversized artifacts, marker splits across chunks, export-all leakage, clean export, and launch without MCP.

The Phase 9 gate runs focused units, GDScript adapter units, real import/reimport/run/build/export integrations, hostile operations, published stdio, release-artifact scan and standalone smoke, serialized regressions, cleanup, and diff checks. Earlier Phase 0–8 gates remain regressions. Current sandbox skips remain explicit and are never described as passing.

## Exclusions

Phase 9 does not install SDKs or export templates, invoke arbitrary build systems, upload/publish artifacts, sign/notarize, choose host destinations, edit arbitrary export preset fields, run arbitrary project commands, or expose general process management. Public multi-platform release orchestration belongs to Phase 11.
