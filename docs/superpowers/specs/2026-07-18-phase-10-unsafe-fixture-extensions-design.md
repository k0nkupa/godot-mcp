# Phase 10 Unsafe Fixture Mode and Extensions Design

- **Date:** 2026-07-18
- **Status:** Approved under the standing phase auto-approval instruction
- **Scope:** Phase 10 only

## Outcome

Phase 10 adds one visibly unsafe `godot_unsafe_fixture` job tool and a narrow extension SDK. Unsafe execution is arbitrary GDScript running as the current OS user and is explicitly **not a sandbox**. It is unreachable unless five independent conditions hold: the `unsafe_fixture` tier, the `unsafe` pack, a server startup flag, an outside-MCP fixture registration matching a project marker, and a one-use second-factor lease with a maximum five-minute lifetime.

Default sessions remain exactly six tools. No existing grant implies unsafe access. Ordinary project checkouts, the registered template itself, stale/mismatched copies, and sessions lacking any one factor expose no unsafe tool.

## Fixture registration and activation

The CLI owns an owner-only registry outside projects. A registration records a UUID, canonical template root digest, marker nonce digest, and creation time. Registration is an explicit local CLI workflow, never an MCP operation. It creates a marker only after the caller confirms the root is disposable.

Unsafe execution occurs only in a disposable copy whose marker binds its registration UUID, template digest, fresh instance UUID, copy creation time, and `disposable: true`. The copy root must differ from the registered template root. Symlinked roots/markers and changed identity fields fail closed.

A separate CLI approval command requires the exact visible phrase `I UNDERSTAND THIS RUNS UNSANDBOXED CODE`, then creates a one-use owner-only activation lease bound to registration, copy identity, project identity, process owner, expiry, and random nonce. `connect --enable-unsafe-fixture <lease>` consumes it at startup. An MCP call cannot create, renew, or extend the lease. The standing routine-approval preference does not remove this product second factor.

## Unsafe process

`godot_unsafe_fixture` supports `execute_start`, `job_status`, `job_cancel`, and `job_result`. Source is UTF-8 GDScript capped at 64 KiB. The control plane writes it under an owned per-job directory in the disposable copy, launches a separate configured Godot process with a fixed `--headless --path <copy> --script <owned-script>` map, and removes source at terminal cleanup. Callers select no executable, host path, arguments, environment, or working directory.

The child receives a scrubbed environment and isolated temporary HOME/config/cache directories, a ten-second maximum deadline, 4 MiB combined output cap, one active job, exact PID/start fingerprint ownership, cancellation, owner-death cleanup, and lease expiry. These controls reduce accidents and secret inheritance; they do not constrain what arbitrary GDScript can access as the current user.

Receipts and every help/capability surface include `unsafe: true` and `sandboxed: false`. Audit stores source SHA-256, byte count, job state, duration, process identity, expiry, and output evidence URI; it never stores source, raw output, environment, host paths, lease nonce, or job token.

Project export is refused while an unsafe job is active. Unsafe source and owned process residue are cleanup-gate failures and leakage markers.

## Extension SDK

The extension SDK registers project-specific typed operations into one `godot_extension` tool. Extensions are trusted local modules explicitly allowlisted at server startup; discovery from project files or MCP input is forbidden. Each definition supplies an extension/operation name, Zod input/output schemas, one existing control-plane `CommandPolicy`, bounded audit summarization, and a handler receiving only a frozen capability facade.

The facade contains the authorized project identity, correlation ID, evidence writer, and explicitly selected typed controllers. It contains no raw bridge session, pairing/runtime/unsafe secrets, audit sink, filesystem API, process launcher, tool registrar, grant mutator, or network client. Registration rejects duplicate names, unsafe policy escalation, unbounded schemas, dynamic tool creation, and output that fails its schema. Execution always passes through the normal authorization, audit, error, and redaction path.

Extensions are trusted code and are not an OS sandbox. The guarantee is narrower: SDK-registered tool execution cannot bypass control-plane authorization/audit through the supplied API, and an extension cannot make itself visible without startup allowlisting.

## Gate

The fixture gate proves normal projects and incomplete grants never expose unsafe execution; registration/marker/copy/lease mismatches fail; leases are consumed and expire; source/process/output are bounded; cancellation and crash cleanup use exact ownership; source is absent from audit; the UI text says unsandboxed; export conflicts with active unsafe jobs; and extension definitions cannot receive forbidden capabilities or skip authorization/audit.

## Exclusions

Phase 10 does not claim hostile-code containment, use containers/VMs, grant arbitrary shell commands, allow unsafe execution in real projects, install extensions from MCP, hot-reload extension code, publish packages, or certify additional Godot/platform matrix cells.
