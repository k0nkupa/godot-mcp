# Phase 0–1 Foundation and Secure Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Phase 0–1 vertical slice: a tested monorepo, shared protocol, disposable Godot 4.7 fixture, reversible CLI-managed addon installation, project identity and permission enforcement, authenticated editor pairing, append-only audit receipts, and the first read-only MCP tools over stdio.

**Architecture:** Codex launches a Node.js MCP server over stdio. The server creates a one-use pairing descriptor and an authenticated loopback WebSocket endpoint; the project-local Godot EditorPlugin connects outward, proves possession of the pairing token, and reports its identity. Every request passes through shared schemas, project identity, permissions, and audit services.

**Tech Stack:** Node.js 22; pnpm 11.13.0 workspaces; TypeScript 6.0.3; Zod 4.4.3; MCP TypeScript SDK 1.29.0; ws 8.21.1; Vitest 4.1.10; ESLint 10.7.0; typescript-eslint 8.64.0; Godot 4.7 stable; GDScript.

## Global Constraints

- The repository is a fully open-source monorepo and all packages share product version `0.1.0` for this phase.
- Node.js 22 is the minimum JavaScript runtime; published code must not require Bun.
- Godot `4.7.stable` is the only certified engine in this plan.
- The MCP transport is stdio; stdout is reserved exclusively for MCP frames and operational logs go to stderr.
- The Godot bridge binds only to `127.0.0.1` on a random port and never scans a port range.
- The addon initiates the WebSocket connection and must authenticate before any command is accepted.
- No autoload, runtime command listener, arbitrary GDScript, arbitrary host filesystem tool, or shell tool may be added.
- Phase 1 exposes only `godot_session`, `godot_capabilities`, `godot_doctor`, and `godot_help`.
- All Phase 1 tools are read-only and require only the `observe` permission.
- Project mutations in this plan are limited to CLI-managed addon/config installation, enablement, disablement, and uninstall.
- Installer changes must be hash-tracked, reversible, and conflict-aware; unrelated project files must be preserved.
- Pairing descriptors are owner-only, expire after 60 seconds, and use a one-use 32-byte random token.
- Every tool call and pairing outcome writes a redacted append-only audit receipt.
- The destructive acceptance target is a temporary copy of `fixtures/godot-4.7`; do not mutate `/Users/tony/Projects/town-building-game` in this plan.
- Follow test-driven development: observe the expected failing test before adding the corresponding implementation.
- Commit after every task with only that task’s files staged.

---

## Planned file map

```text
package.json                         Root scripts and pinned toolchain
pnpm-workspace.yaml                  Workspace package discovery
tsconfig.base.json                   Shared strict TypeScript settings
eslint.config.mjs                    Shared lint rules
vitest.config.ts                     Unit/integration test discovery
.gitignore                           Build, cache, evidence, and Godot ignores
LICENSE                              MIT license
README.md                            Phase 1 installation and security boundary

packages/protocol/                   Product constants and shared schemas
packages/control-plane/              Project, policy, auth, session, audit
packages/bridge-client/              Loopback WebSocket server and handshake
packages/mcp-server/                 Read-only MCP tools and stdio transport
packages/cli/                        init/connect/doctor/disable/uninstall
packages/testkit/                    Temp project and Godot process helpers

addons/godot_mcp/                    Source Godot EditorPlugin
fixtures/godot-4.7/                  Disposable acceptance project
fixtures/hostile/                    Symlink and malformed-input fixtures
scripts/                             Protocol generation and phase gate
tests/end-to-end/                    Published stdio plus real-editor flow
.github/workflows/ci.yml             Node and macOS/Godot verification
```

Workspace dependencies are fixed in Task 1 so later tasks do not improvise package ownership:

| Package | Runtime dependencies | Development dependencies |
|---|---|---|
| `protocol` | `zod@4.4.3` | none |
| `control-plane` | `@godot-mcp/protocol@workspace:*`, `zod@4.4.3` | `@godot-mcp/testkit@workspace:*` |
| `bridge-client` | `@godot-mcp/control-plane@workspace:*`, `@godot-mcp/protocol@workspace:*`, `ws@8.21.1` | `@godot-mcp/testkit@workspace:*`, `@types/ws@8.18.1` |
| `mcp-server` | `@godot-mcp/control-plane@workspace:*`, `@godot-mcp/protocol@workspace:*`, `@modelcontextprotocol/sdk@1.29.0`, `zod@4.4.3` | none |
| `cli` | `@godot-mcp/bridge-client@workspace:*`, `@godot-mcp/control-plane@workspace:*`, `@godot-mcp/mcp-server@workspace:*`, `@godot-mcp/protocol@workspace:*` | `@godot-mcp/testkit@workspace:*` |
| `testkit` | `@modelcontextprotocol/sdk@1.29.0` | none |

## Task 1: Bootstrap the workspace and quality gates

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `README.md`
- Create: `tests/meta/workspace.test.ts`
- Create: `packages/{protocol,control-plane,bridge-client,mcp-server,cli,testkit}/package.json`
- Create: `packages/{protocol,control-plane,bridge-client,mcp-server,cli,testkit}/tsconfig.json`
- Create: `packages/{protocol,control-plane,bridge-client,mcp-server,cli,testkit}/src/index.ts`

**Interfaces:**
- Produces workspace package names `@godot-mcp/protocol`, `@godot-mcp/control-plane`, `@godot-mcp/bridge-client`, `@godot-mcp/mcp-server`, `@godot-mcp/cli`, and `@godot-mcp/testkit`.
- Produces root commands `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm qa`.

- [ ] **Step 1: Create the root manifest and a failing workspace contract test**

```json
{
  "name": "godot-mcp-monorepo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.13.0",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "qa": "pnpm build && pnpm lint && pnpm typecheck && pnpm test"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "@vitest/coverage-v8": "4.1.10",
    "eslint": "10.7.0",
    "typescript": "6.0.3",
    "typescript-eslint": "8.64.0",
    "vitest": "4.1.10"
  }
}
```

```ts
// tests/meta/workspace.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const names = ["protocol", "control-plane", "bridge-client", "mcp-server", "cli", "testkit"];

describe("workspace package contract", () => {
  it.each(names)("defines @godot-mcp/%s at product version 0.1.0", async (name) => {
    const json = JSON.parse(await readFile(`packages/${name}/package.json`, "utf8"));
    expect(json).toMatchObject({ name: `@godot-mcp/${name}`, version: "0.1.0", type: "module" });
  });
});
```

- [ ] **Step 2: Install the pinned package manager and verify the test fails**

Run:

```bash
corepack enable
corepack prepare pnpm@11.13.0 --activate
pnpm install
pnpm test -- tests/meta/workspace.test.ts
```

Expected: FAIL with `ENOENT` for the first missing workspace `package.json`.

- [ ] **Step 3: Add workspace configuration and package manifests**

Use this manifest shape for every package, changing only `name`; add `bin` only to `packages/cli/package.json`:

```json
{
  "name": "@godot-mcp/protocol",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Add the exact runtime and development dependencies from the dependency table above to each package manifest. Use only `workspace:*` for internal packages.

`packages/cli/package.json` additionally contains:

```json
"bin": { "godot-mcp": "./dist/bin.js" }
```

Use this package TypeScript configuration:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

Set `pnpm-workspace.yaml` to:

```yaml
packages:
  - packages/*
```

Set the shared compiler options to strict ESM with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `resolveJsonModule`, declarations, source maps, and NodeNext module resolution. Package builds resolve internal dependencies from the preceding topological workspace build; do not compile another package’s source into the current package.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": false,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Add lint, test, ignore, and license configuration**

`vitest.config.ts` must include `tests/**/*.test.ts` and `packages/*/src/**/*.test.ts`, alias every `@godot-mcp/<name>` package to `packages/<name>/src/index.ts`, use the Node environment, restore mocks, and set a 10-second unit timeout. `.gitignore` must exclude `node_modules/`, `dist/`, `coverage/`, `.godot/`, `.godot-mcp/evidence/`, and `*.log`, but not source addon files.

```ts
// vitest.config.ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packages = ["protocol", "control-plane", "bridge-client", "mcp-server", "cli", "testkit"];
export default defineConfig({
  resolve: { alias: Object.fromEntries(packages.map((name) => [
    `@godot-mcp/${name}`, resolve(`packages/${name}/src/index.ts`)
  ])) },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000
  }
});
```

Create a minimal README stating that the repository contains an approved design and Phase 0–1 is not implemented yet. Use the standard MIT license text with `Copyright (c) 2026 Godot MCP contributors`.

- [ ] **Step 5: Run all workspace checks**

Run: `pnpm qa`

Expected: PASS with one workspace contract test and six package builds.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs vitest.config.ts .gitignore LICENSE README.md tests/meta packages/*/package.json packages/*/tsconfig.json packages/*/src/index.ts
git commit -m "chore: bootstrap Godot MCP workspace"
```

## Task 2: Define shared protocol schemas and generated Godot constants

**Files:**
- Create: `packages/protocol/src/version.ts`
- Create: `packages/protocol/product.json`
- Create: `packages/protocol/src/schemas.ts`
- Create: `packages/protocol/src/canonicalJson.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/package.json`
- Create: `packages/protocol/src/schemas.test.ts`
- Create: `packages/protocol/src/canonicalJson.test.ts`
- Create: `packages/protocol/fixtures/canonical-json-v1.json`
- Create: `scripts/generate-godot-protocol.mjs`
- Create: `addons/godot_mcp/generated/protocol_constants.gd`

**Interfaces:**
- Produces `PRODUCT_VERSION`, `BRIDGE_PROTOCOL_VERSION`, `PermissionTierSchema`, `CapabilityPackSchema`, `ProjectIdentitySchema`, `BridgeEnvelopeSchema`, `ToolResultSchema`, `GodotMcpErrorSchema`, `AuditRecordSchema`, and `canonicalJson(value)`.
- `canonicalJson` sorts object keys recursively, preserves array order, rejects non-finite numbers, and emits UTF-8 JSON without insignificant whitespace.

- [ ] **Step 1: Write failing schema and canonicalization tests**

```ts
import { describe, expect, it } from "vitest";
import { BridgeEnvelopeSchema, PermissionTierSchema, canonicalJson } from "./index.js";

describe("protocol", () => {
  it("rejects an unknown permission tier", () => {
    expect(PermissionTierSchema.safeParse("admin").success).toBe(false);
  });

  it("requires signed envelopes after pairing", () => {
    expect(BridgeEnvelopeSchema.safeParse({ sessionId: "s", sequence: 1 }).success).toBe(false);
  });

  it("canonicalizes nested objects deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: [2, 1] } }))
      .toBe('{"a":{"x":[2,1],"y":true},"z":1}');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- packages/protocol/src/schemas.test.ts packages/protocol/src/canonicalJson.test.ts`

Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Implement version constants, canonical JSON, and schemas**

```ts
// packages/protocol/src/version.ts
import product from "../product.json" with { type: "json" };

export const PRODUCT_VERSION = product.productVersion as "0.1.0";
export const BRIDGE_PROTOCOL_VERSION = product.bridgeProtocolVersion as "1.0";
```

```json
// packages/protocol/product.json
{ "productVersion": "0.1.0", "bridgeProtocolVersion": "1.0" }
```

```ts
// packages/protocol/src/schemas.ts
import { z } from "zod";

export const PermissionTierSchema = z.enum([
  "observe", "runtime_control", "project_mutate", "project_operate", "unsafe_fixture"
]);
export const CapabilityPackSchema = z.enum([
  "core", "runtime", "input", "editor", "debug", "visual", "project", "unsafe"
]);
export const ProjectIdentitySchema = z.object({
  projectId: z.uuid(),
  rootRealPath: z.string().min(1),
  projectConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
  godotVersion: z.string().min(1).optional()
});
export const BridgeEnvelopeSchema = z.object({
  sessionId: z.string().min(16),
  sequence: z.number().int().positive(),
  deadlineUnixMs: z.number().int().positive(),
  method: z.string().min(1),
  params: z.unknown(),
  mac: z.string().regex(/^[a-f0-9]{64}$/)
});
export const GodotMcpErrorSchema = z.object({
  code: z.enum([
    "NOT_ATTACHED", "AUTHENTICATION_FAILED", "PERMISSION_REQUIRED", "VERSION_MISMATCH",
    "PROJECT_CHANGED", "PATH_DENIED", "INVALID_REQUEST", "PAYLOAD_TOO_LARGE",
    "TARGET_NOT_FOUND", "STALE_HANDLE",
    "PRECONDITION_FAILED", "CONFLICT", "TIMEOUT", "CANCELLED", "GODOT_PARSE_ERROR",
    "GODOT_RUNTIME_ERROR", "ASSERTION_FAILED", "ROLLBACK_FAILED", "EXPORT_LEAK_DETECTED"
  ]),
  message: z.string(),
  retryable: z.boolean(),
  correlationId: z.string(),
  partialEffects: z.boolean(),
  rollback: z.enum(["not_needed", "succeeded", "failed", "not_attempted"])
});
export const ToolResultSchema = z.object({
  ok: z.boolean(), data: z.unknown(), warnings: z.array(z.string()), evidence: z.array(z.string()),
  changes: z.array(z.unknown()), auditId: z.string(), correlationId: z.string()
});
export const AuditRecordSchema = z.object({
  schemaVersion: z.literal(1), auditId: z.string(), correlationId: z.string(),
  sessionId: z.string().nullable(), projectId: z.string(), event: z.string(), outcome: z.string(),
  permissionTier: PermissionTierSchema, protocolVersion: z.string(),
  startedAt: z.string(), finishedAt: z.string(), arguments: z.unknown(), errorCode: z.string().nullable()
});

export type PermissionTier = z.infer<typeof PermissionTierSchema>;
export type CapabilityPack = z.infer<typeof CapabilityPackSchema>;
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;
export type GodotMcpError = z.infer<typeof GodotMcpErrorSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
```

Implement `canonicalJson` as a recursive normalizer that throws on `undefined`, bigint, functions, symbols, cycles, non-finite numbers, non-integers, and integers outside JavaScript’s safe range before calling `JSON.stringify`. Bridge protocol v1 represents future floating-point Godot variants as tagged strings rather than native JSON numbers, avoiding TypeScript/GDScript formatting drift.

- [ ] **Step 4: Add protocol fixture and generator**

The fixture must contain at least strings, booleans, null, nested objects, arrays, escaped Unicode, zero, and the safe-integer boundaries `-9007199254740991` and `9007199254740991` used by both TypeScript and GDScript tests. The generator reads `packages/protocol/product.json` and writes only:

```gdscript
@tool
class_name GodotMcpProtocolConstants
extends RefCounted

const PRODUCT_VERSION := "0.1.0"
const BRIDGE_PROTOCOL_VERSION := "1.0"
```

Run: `node scripts/generate-godot-protocol.mjs`

- [ ] **Step 5: Verify generated output and tests**

Run:

```bash
pnpm test -- packages/protocol
node scripts/generate-godot-protocol.mjs --check
pnpm --filter @godot-mcp/protocol typecheck
```

Expected: PASS; `--check` exits zero only when the generated GDScript matches.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol scripts/generate-godot-protocol.mjs addons/godot_mcp/generated
git commit -m "feat: define bridge protocol contracts"
```

## Task 3: Create the disposable Godot 4.7 fixture and addon skeleton

**Files:**
- Create: `fixtures/godot-4.7/project.godot`
- Create: `fixtures/godot-4.7/main.tscn`
- Create: `fixtures/godot-4.7/main.gd`
- Create: `fixtures/godot-4.7/icon.svg`
- Create: `fixtures/godot-4.7/.gitignore`
- Create: `fixtures/godot-4.7/tests/fixture_smoke.gd`
- Create: `addons/godot_mcp/plugin.cfg`
- Create: `addons/godot_mcp/plugin.gd`
- Create: `packages/testkit/src/godot.ts`
- Create: `packages/testkit/src/tempProject.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `packages/testkit/package.json`
- Create: `tests/integration/godot-fixture.test.ts`

**Interfaces:**
- Produces `findGodotBinary(): Promise<string>`, `runGodot(args, options)`, `copyFixture(): Promise<TempProject>`, and `waitUntil(check, timeoutMs, intervalMs)`.
- `TempProject.cleanup()` removes only its own temporary directory; `TempProject.diffFromOriginal()` returns sorted changed relative paths while ignoring `.godot/`.

- [ ] **Step 1: Write a failing real-engine fixture test**

```ts
import { expect, test } from "vitest";
import { runGodot } from "@godot-mcp/testkit";

test("Godot 4.7 fixture parses and runs", async () => {
  const result = await runGodot([
    "--headless", "--path", "fixtures/godot-4.7", "--script", "res://tests/fixture_smoke.gd"
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("GODOT_MCP_FIXTURE_OK");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm test -- tests/integration/godot-fixture.test.ts`

Expected: FAIL because the fixture or testkit exports do not exist.

- [ ] **Step 3: Implement the fixture and smoke script**

The main scene is a `Node2D` named `Main` with a `Label` named `StatusLabel`, text `fixture-ready`, and `main.gd` printing `GODOT_MCP_MAIN_READY` from `_ready()`.

```gdscript
# fixtures/godot-4.7/tests/fixture_smoke.gd
extends SceneTree

func _init() -> void:
	var packed := load("res://main.tscn") as PackedScene
	assert(packed != null)
	var scene := packed.instantiate()
	assert(scene.get_node("StatusLabel").text == "fixture-ready")
	print("GODOT_MCP_FIXTURE_OK")
	quit(0)
```

Set `config/features=PackedStringArray("4.7")`, the main scene, and a deterministic 640×360 viewport in `project.godot`.

- [ ] **Step 4: Implement the addon skeleton and testkit helpers**

```gdscript
# addons/godot_mcp/plugin.gd
@tool
extends EditorPlugin

func _enter_tree() -> void:
	print("GODOT_MCP_ADDON_ENTERED")

func _exit_tree() -> void:
	print("GODOT_MCP_ADDON_EXITED")
```

`runGodot` must use `spawn`, collect stdout/stderr separately, enforce a caller-provided timeout, kill only the spawned PID, and return `{ exitCode, stdout, stderr }`. It must verify `godot --version` starts with `4.7.stable` before integration tests proceed.

- [ ] **Step 5: Verify fixture import, execution, and checks**

Run:

```bash
/opt/homebrew/bin/godot --headless --path fixtures/godot-4.7 --import --quit
GODOT_BIN=/opt/homebrew/bin/godot pnpm test -- tests/integration/godot-fixture.test.ts
pnpm --filter @godot-mcp/testkit typecheck
```

Expected: PASS and `GODOT_MCP_FIXTURE_OK` appears.

- [ ] **Step 6: Commit**

```bash
git add fixtures addons/godot_mcp/plugin.cfg addons/godot_mcp/plugin.gd packages/testkit tests/integration/godot-fixture.test.ts
git commit -m "test: add disposable Godot 4.7 fixture"
```

## Task 4: Implement project discovery, identity, and path containment

**Files:**
- Create: `packages/control-plane/src/project/projectConfig.ts`
- Create: `packages/control-plane/src/project/projectIdentity.ts`
- Create: `packages/control-plane/src/project/pathPolicy.ts`
- Create: `packages/control-plane/src/errors.ts`
- Create: `packages/control-plane/src/project/projectIdentity.test.ts`
- Create: `packages/control-plane/src/project/pathPolicy.test.ts`
- Modify: `packages/control-plane/src/index.ts`
- Modify: `packages/control-plane/package.json`

**Interfaces:**
- Produces `discoverProject(inputPath): Promise<DiscoveredProject>`.
- Produces `createProjectConfig(root): Promise<ProjectConfig>` and `readProjectIdentity(root): Promise<ProjectIdentity>`.
- Produces `resolveProjectPath(identity, resPath, mode): Promise<string>` where `mode` is `"read" | "write"`.
- Produces throwable `GodotMcpException extends Error` with validated `code`, `retryable`, `correlationId`, `partialEffects`, and `rollback` fields.

- [ ] **Step 1: Write failing discovery and escape tests**

```ts
it("fingerprints project.godot and uses the configured UUID", async () => {
  const temp = await copyFixture();
  const config = await createProjectConfig(temp.root);
  const identity = await readProjectIdentity(temp.root);
  expect(identity.projectId).toBe(config.projectId);
  expect(identity.projectConfigSha256).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects a symlink that escapes res://", async () => {
  const temp = await copyFixture();
  await symlink("/tmp", join(temp.root, "escape"));
  const identity = await readProjectIdentity(temp.root);
  await expect(resolveProjectPath(identity, "res://escape/secret", "read"))
    .rejects.toMatchObject({ code: "PATH_DENIED" });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test -- packages/control-plane/src/project`

Expected: FAIL because project services are undefined.

- [ ] **Step 3: Implement project configuration and identity**

`.godot-mcp.json` uses this exact schema:

```ts
const ProjectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.uuid(),
  addonVersion: z.literal("0.1.0"),
  allowedResourceRoots: z.array(z.string()).default(["res://"])
});
```

`discoverProject` accepts either a directory or `project.godot`, resolves the real path, verifies a regular `project.godot`, and does not search above the supplied path. `createProjectConfig` uses `randomUUID()`, mode `0o600`, and exclusive creation; an existing valid config is returned unchanged.

Implement `GodotMcpException` by accepting `GodotMcpError`, validating it with `GodotMcpErrorSchema`, copying the structured fields, setting `name = "GodotMcpException"`, and never embedding a secret-bearing cause in the public message.

- [ ] **Step 4: Implement containment**

Reject absolute inputs, `user://`, `..`, null bytes, `.git`, `.env`, credential-like filenames, and any real path outside the canonical root. For a new write target, resolve the nearest existing parent before containment comparison. Return a typed `GodotMcpError` with `PATH_DENIED`.

```ts
export async function resolveProjectPath(
  identity: ProjectIdentity,
  resPath: string,
  mode: "read" | "write"
): Promise<string> {
  if (!resPath.startsWith("res://") || resPath.includes("\0")) throw pathDenied(resPath);
  const relative = resPath.slice("res://".length);
  const parts = relative.split("/");
  if (parts.some((part) => part === ".." || part === ".git" || /^\.env(?:\.|$)/i.test(part))) {
    throw pathDenied(resPath);
  }
  const candidate = resolve(identity.rootRealPath, relative);
  const anchor = mode === "read" ? await realpath(candidate) : await nearestExistingRealParent(candidate);
  const rel = relativePath(identity.rootRealPath, anchor);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw pathDenied(resPath);
  return candidate;
}
```

Implement `nearestExistingRealParent` by walking parents only on `ENOENT`, stopping at the project root, and calling `realpath` on the first existing parent. `relativePath` is an alias of `node:path.relative`; the alias avoids collision with the `relative` local variable.

- [ ] **Step 5: Run focused and package checks**

Run:

```bash
pnpm test -- packages/control-plane/src/project
pnpm --filter @godot-mcp/control-plane typecheck
```

Expected: PASS including symlink and missing-parent cases.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/project packages/control-plane/src/index.ts packages/control-plane/package.json
git commit -m "feat: add project identity and containment"
```

## Task 5: Implement reversible addon installation and CLI lifecycle commands

**Files:**
- Create: `packages/cli/src/install/addonManifest.ts`
- Create: `packages/cli/src/install/addonInstaller.ts`
- Create: `packages/cli/src/install/pluginState.ts`
- Create: `packages/cli/src/install/doctor.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/disable.ts`
- Create: `packages/cli/src/commands/uninstall.ts`
- Create: `packages/cli/src/commands/doctor.ts`
- Create: `packages/cli/src/install/addonInstaller.test.ts`
- Create: `packages/cli/src/install/doctor.test.ts`
- Create: `packages/cli/godot/plugin_state.gd`
- Create: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`
- Create: `tests/integration/addon-lifecycle.test.ts`

**Interfaces:**
- Produces `installAddon(project, sourceDir)`, `disableAddon(project, godotBin)`, `uninstallAddon(project)`, and `runDoctor(project)`.
- CLI exit codes: `0` healthy/success, `2` invalid arguments, `3` conflict, `4` unhealthy installation.

- [ ] **Step 1: Write failing installer conflict tests**

```ts
it("installs exact addon files and refuses to overwrite a user modification", async () => {
  const project = await copyFixture();
  await installAddon(project.root, "addons/godot_mcp");
  const installed = join(project.root, "addons/godot_mcp/plugin.gd");
  await appendFile(installed, "\n# user change\n");
  await expect(uninstallAddon(project.root)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readFile(installed, "utf8")).toContain("# user change");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `pnpm test -- packages/cli/src/install`

Expected: FAIL because lifecycle functions do not exist.

- [ ] **Step 3: Implement manifest and installer**

Store the install manifest at `.godot/godot-mcp/install-manifest.json` with schema version, product version, install timestamp, a `manifestSha256`, and sorted `{ relativePath, sha256 }` entries. Compute `manifestSha256` from the canonical JSON of the sorted file entries. Copy through a temporary sibling directory, verify hashes, then rename. Never delete a destination file whose current hash differs from the manifest. The addon reads this non-secret manifest through `ProjectSettings.globalize_path()` and reports its digest during pairing.

Track the exact preimage and postimage hashes of `project.godot` plus the created `.godot-mcp.json` hash. On an unchanged temporary project, uninstall restores the exact `project.godot` preimage and removes `.godot-mcp.json`. If either file has changed independently, preserve it and return a conflict instead of overwriting unrelated user work.

`init` must:

1. Discover the project.
2. Create or validate `.godot-mcp.json`.
3. Install exact addon files.
4. Enable the addon using the Godot helper.
5. Run doctor and print structured JSON to stdout when not serving MCP.

- [ ] **Step 4: Implement plugin enable/disable helper**

```gdscript
# packages/cli/godot/plugin_state.gd
extends SceneTree

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	assert(args.size() == 1 and args[0] in ["enable", "disable"])
	var enabled := ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()) as PackedStringArray
	var path := "res://addons/godot_mcp/plugin.cfg"
	if args[0] == "enable" and not enabled.has(path): enabled.append(path)
	if args[0] == "disable":
		var updated := PackedStringArray()
		for item in enabled:
			if item != path: updated.append(item)
		enabled = updated
	ProjectSettings.set_setting("editor_plugins/enabled", enabled)
	var error := ProjectSettings.save()
	quit(0 if error == OK else 1)
```

Invoke it with `godot --headless --path <project> --script <absolute-helper> -- enable|disable`. Capture output and require Godot 4.7.

- [ ] **Step 5: Implement doctor and CLI parsing**

Doctor checks project config, addon manifest, every installed hash, plugin enabled state, Godot version, and stale runtime directory entries. Return `{ healthy, checks: [{ name, status, detail }] }`; do not mutate.

Use `node:util.parseArgs` in `bin.ts`. Supported exact commands are `init`, `doctor`, `disable`, `uninstall`, and later `connect`. Error messages go to stderr.

- [ ] **Step 6: Run unit and real-Godot lifecycle tests**

Run:

```bash
pnpm test -- packages/cli/src/install
GODOT_BIN=/opt/homebrew/bin/godot pnpm test -- tests/integration/addon-lifecycle.test.ts
```

Expected: PASS; init enables the addon, disable removes it from project settings, uninstall returns all tracked addon files to absence, and conflict preserves user edits.

- [ ] **Step 7: Commit**

```bash
git add packages/cli tests/integration/addon-lifecycle.test.ts
git commit -m "feat: add reversible addon lifecycle CLI"
```

## Task 6: Implement permission and capability policy

**Files:**
- Create: `packages/control-plane/src/policy/capabilities.ts`
- Create: `packages/control-plane/src/policy/authorize.ts`
- Create: `packages/control-plane/src/policy/authorize.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces `SessionGrants`, `CommandPolicy`, `authorize(grants, policy)`, and `visibleCapabilities(grants)`.
- Phase 1 command policies all require `observe` and pack `core`.

- [ ] **Step 1: Write failing least-privilege tests**

```ts
it("allows a core read with observe only", () => {
  expect(authorize({ tiers: ["observe"], packs: ["core"] }, CORE_SESSION_POLICY)).toEqual({ allowed: true });
});

it("denies project mutation without both tier and pack", () => {
  expect(() => authorize(
    { tiers: ["observe", "project_mutate"], packs: ["core"] },
    { command: "editor.batch", tier: "project_mutate", pack: "editor", mutating: true }
  )).toThrowError(expect.objectContaining({ code: "PERMISSION_REQUIRED" }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/control-plane/src/policy/authorize.test.ts`

Expected: FAIL because policy exports do not exist.

- [ ] **Step 3: Implement exact policy evaluation**

```ts
export interface SessionGrants {
  tiers: PermissionTier[];
  packs: CapabilityPack[];
}
export interface CommandPolicy {
  command: string;
  tier: PermissionTier;
  pack: CapabilityPack;
  mutating: boolean;
}
export function authorize(grants: SessionGrants, policy: CommandPolicy): { allowed: true } {
  if (!grants.tiers.includes(policy.tier) || !grants.packs.includes(policy.pack)) {
    throw permissionRequired(policy);
  }
  return { allowed: true };
}
```

Do not infer higher tiers from names. Expansion is explicit through a constant cumulative-tier map, and unsafe is never implied by another tier.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test -- packages/control-plane/src/policy && pnpm --filter @godot-mcp/control-plane typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/policy packages/control-plane/src/index.ts
git commit -m "feat: enforce capability permissions"
```

## Task 7: Implement redacted append-only audit receipts

**Files:**
- Create: `packages/control-plane/src/audit/redact.ts`
- Create: `packages/control-plane/src/audit/jsonlAuditSink.ts`
- Create: `packages/control-plane/src/audit/jsonlAuditSink.test.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces `AuditSink.append(input): Promise<AuditRecord>` and `redactAuditValue(value)`.
- Records are serialized in call order and stored at `.godot/evidence/godot-mcp/audit.jsonl` unless an explicit test path is injected.

- [ ] **Step 1: Write failing redaction and concurrency tests**

```ts
it("redacts nested secrets and writes complete JSONL under concurrency", async () => {
  const sink = new JsonlAuditSink(path);
  await Promise.all(Array.from({ length: 50 }, (_, index) => sink.append(baseRecord({
    event: `event-${index}`, arguments: { token: "secret", nested: { password: "hidden" } }
  }))));
  const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  expect(lines).toHaveLength(50);
  expect(lines[0].arguments).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]" } });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/control-plane/src/audit/jsonlAuditSink.test.ts`

Expected: FAIL because `JsonlAuditSink` is undefined.

- [ ] **Step 3: Implement redaction and serialized append**

Redact keys matching `token|secret|password|authorization|cookie|private[_-]?key` case-insensitively at every depth. Replace binary values with `[BINARY <n> bytes]`. Detect cycles and replace them with `[CIRCULAR]`.

Implement a private promise chain so each append validates `AuditRecordSchema`, opens with `0o600`, writes exactly one JSON object plus newline, and closes before resolving. Failed appends reject the operation; they are never silently ignored.

```ts
export class JsonlAuditSink implements AuditSink {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(input: AuditInput): Promise<AuditRecord> {
    const record = AuditRecordSchema.parse(buildAuditRecord(input, redactAuditValue(input.arguments)));
    const write = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await open(this.path, "a", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); }
      finally { await handle.close(); }
      return record;
    });
    this.tail = write.catch(() => undefined);
    return write;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test -- packages/control-plane/src/audit && pnpm --filter @godot-mcp/control-plane typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/audit packages/control-plane/src/index.ts
git commit -m "feat: add redacted audit receipts"
```

## Task 8: Implement pairing descriptors and signed-envelope primitives

**Files:**
- Create: `packages/control-plane/src/auth/runtimeDirectory.ts`
- Create: `packages/control-plane/src/auth/pairingDescriptor.ts`
- Create: `packages/control-plane/src/auth/sessionCrypto.ts`
- Create: `packages/control-plane/src/auth/pairingDescriptor.test.ts`
- Create: `packages/control-plane/src/auth/sessionCrypto.test.ts`
- Create: `packages/protocol/fixtures/session-crypto-v1.json`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces `createPairingDescriptor(project, port, grants): Promise<PairingMaterial>`.
- Produces `consumePairingDescriptor(path): Promise<SessionDescriptor>`.
- Produces `deriveSessionKey(token, sessionNonce, serverNonce)`, `signEnvelope`, and `verifyEnvelope`.

- [ ] **Step 1: Write failing token, mode, expiry, and replay tests**

```ts
it("creates a 0600 descriptor with a 32-byte one-use token", async () => {
  const material = await createPairingDescriptor(project, 43123, observeGrants);
  expect(Buffer.from(material.descriptor.token, "base64url")).toHaveLength(32);
  expect((await stat(material.path)).mode & 0o777).toBe(0o600);
  await consumePairingDescriptor(material.path);
  await expect(consumePairingDescriptor(material.path)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
});

it("rejects a repeated signed sequence", () => {
  const verifier = new EnvelopeVerifier(key, { now: () => 1_000 });
  verifier.verify(signEnvelope(key, envelope({ sequence: 1, deadlineUnixMs: 2_000 })));
  expect(() => verifier.verify(signEnvelope(key, envelope({ sequence: 1, deadlineUnixMs: 2_000 }))))
    .toThrowError(expect.objectContaining({ code: "AUTHENTICATION_FAILED" }));
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test -- packages/control-plane/src/auth`

Expected: FAIL because auth primitives do not exist.

- [ ] **Step 3: Implement runtime directory and descriptor lifecycle**

Use `$XDG_RUNTIME_DIR/godot-mcp` when set; otherwise use `path.join(os.tmpdir(), "godot-mcp")`. Both XDG runtime directories and the platform temp directory are already user-scoped on the certified macOS path. Create the child directory as `0o700`, reject a symlinked runtime directory, and create descriptors with `flag: "wx"`, mode `0o600`, and a 60-second expiry. The GDScript reader uses `XDG_RUNTIME_DIR`, then `TMPDIR`, with the same `godot-mcp/pair-<projectId>.json` suffix.

The descriptor schema contains protocol version, product version, project identity, port, session nonce, one-use token, grants, creation, and expiry. Its exact filename is `pair-<projectId>.json`. `consumePairingDescriptor` atomically renames to a private consuming filename before reading, validates expiry, and deletes it in `finally`.

- [ ] **Step 4: Implement session key and envelope authentication**

Derive the 32-byte key as:

```ts
createHmac("sha256", Buffer.from(token, "base64url"))
  .update(`godot-mcp:v1\n${sessionNonce}\n${serverNonce}`, "utf8")
  .digest();
```

Sign `sessionId`, `sequence`, `deadlineUnixMs`, `method`, and `canonicalJson(params)` separated by newlines. Verify with `timingSafeEqual`, a strictly increasing sequence, and a deadline no more than 60 seconds in the future.

- [ ] **Step 5: Add stable cross-language crypto fixtures and run tests**

The fixture contains fixed token/nonces, one envelope, canonical payload text, derived key hex, and MAC hex. Do not use production randomness in the fixture.

Run: `pnpm test -- packages/control-plane/src/auth && pnpm --filter @godot-mcp/control-plane typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/auth packages/control-plane/src/index.ts packages/protocol/fixtures/session-crypto-v1.json
git commit -m "feat: add secure pairing primitives"
```

## Task 9: Implement the loopback bridge server and handshake state machine

**Files:**
- Create: `packages/bridge-client/src/bridgeServer.ts`
- Create: `packages/bridge-client/src/handshake.ts`
- Create: `packages/bridge-client/src/bridgeSession.ts`
- Create: `packages/bridge-client/src/bridgeServer.test.ts`
- Modify: `packages/bridge-client/src/index.ts`
- Modify: `packages/bridge-client/package.json`

**Interfaces:**
- Produces `startBridgeServer(options): Promise<BridgeServer>`.
- `BridgeServer` exposes `port`, `descriptorPath`, `waitForAttachment(timeoutMs)`, `session`, and `close()`.
- The only unauthenticated message is `pair`; all later messages are signed envelopes.

- [ ] **Step 1: Write failing valid, invalid, expiry, and replay handshake tests**

```ts
it("pairs once and rejects a replayed token", async () => {
  const server = await startTestBridge();
  const descriptor = await readDescriptorForTest(server.descriptorPath);
  const first = await pairClient(descriptor);
  expect(first.sessionId).toMatch(/^session_/);
  await expect(pairClient(descriptor)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  await server.close();
});

it("binds only to IPv4 loopback", async () => {
  const server = await startTestBridge();
  expect(server.address).toMatchObject({ address: "127.0.0.1" });
  await server.close();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test -- packages/bridge-client/src/bridgeServer.test.ts`

Expected: FAIL because the bridge server does not exist.

- [ ] **Step 3: Implement the server with strict transport limits**

Create `WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1_048_576, perMessageDeflate: false })`. Reject unexpected HTTP paths, more than one pending connection, binary pairing frames, malformed JSON, and any pre-auth method other than `pair`.

```ts
const websocket = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  path: "/bridge",
  maxPayload: 1_048_576,
  perMessageDeflate: false,
  clientTracking: true
});

websocket.on("connection", (socket, request) => {
  if (request.socket.remoteAddress !== "127.0.0.1" || pendingOrAttachedClient()) {
    socket.close(1008, "connection rejected");
    return;
  }
  beginUnauthenticatedHandshake(socket);
});
```

`beginUnauthenticatedHandshake` installs a one-message handler with a five-second deadline. It closes with 1008 on binary, malformed, or non-pair input and removes its timer/listener before transferring the socket to `BridgeSession`.

The pair request includes token, session nonce, protocol/product versions, canonical project identity, addon manifest hash, and Godot version. Compare secrets with `timingSafeEqual`. On success, delete the descriptor, derive the key, and return a session ID, server nonce, grants, and `serverProof = HMAC(token, "godot-mcp:server-proof:v1\\n" + sessionId + "\\n" + serverNonce)`. Move the socket to signed-envelope mode only after the client acknowledges a valid proof.

- [ ] **Step 4: Wire audit outcomes and deterministic close**

Audit `pair.succeeded`, `pair.rejected`, `session.closed`, and transport-limit failures. `close()` stops accepting, closes the authenticated socket with code 1001, removes an unconsumed descriptor, closes the WebSocket server, and resolves idempotently.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm test -- packages/bridge-client && pnpm --filter @godot-mcp/bridge-client typecheck`

Expected: PASS, including wrong token, wrong project, expired token, oversized frame, and repeated close.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge-client
git commit -m "feat: add authenticated loopback bridge"
```

## Task 10: Implement the Godot EditorPlugin pairing client

**Files:**
- Create: `addons/godot_mcp/bridge/canonical_json.gd`
- Create: `addons/godot_mcp/bridge/session_crypto.gd`
- Create: `addons/godot_mcp/bridge/descriptor_reader.gd`
- Create: `addons/godot_mcp/bridge/bridge_client.gd`
- Modify: `addons/godot_mcp/plugin.gd`
- Create: `fixtures/godot-4.7/tests/protocol_fixture_test.gd`
- Create: `tests/integration/editor-pairing.test.ts`

**Interfaces:**
- `GodotMcpBridgeClient.start(project_identity)` begins nonblocking pairing.
- Signals: `attached(session_info)`, `rejected(code, message)`, and `disconnected(reason)`.
- The plugin registers no listener and opens no connection until a matching descriptor exists.

- [ ] **Step 1: Write a failing GDScript crypto-fixture test and editor-pairing test**

```gdscript
extends SceneTree

func _init() -> void:
	var fixture := JSON.parse_string(FileAccess.get_file_as_string("res://protocol-fixtures/session-crypto-v1.json"))
	var key := GodotMcpSessionCrypto.derive_key(fixture.token, fixture.sessionNonce, fixture.serverNonce)
	assert(key.hex_encode() == fixture.derivedKeyHex)
	assert(GodotMcpSessionCrypto.sign(fixture.envelope, key) == fixture.macHex)
	print("GODOT_MCP_PROTOCOL_FIXTURE_OK")
	quit(0)
```

The TypeScript integration test copies the fixture, copies `packages/protocol/fixtures/session-crypto-v1.json` into `<copy>/protocol-fixtures/`, installs/enables the addon, starts `BridgeServer`, launches `godot --headless --editor --path <copy>`, and waits up to 10 seconds for `waitForAttachment`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm test -- tests/integration/editor-pairing.test.ts
```

Expected: FAIL because the addon bridge classes are absent.

- [ ] **Step 3: Implement canonical JSON and HMAC from shared fixtures**

Use recursive sorted dictionary keys, array order preservation, finite-number checks, UTF-8 encoding, and `HMACContext` with SHA-256. Do not call `str(dictionary)` for signed content. Return lowercase hex MACs.

```gdscript
static func hmac_sha256(key: PackedByteArray, message: String) -> PackedByteArray:
	var context := HMACContext.new()
	var error := context.start(HashingContext.HASH_SHA256, key)
	assert(error == OK)
	error = context.update(message.to_utf8_buffer())
	assert(error == OK)
	return context.finish()
```

The canonicalizer rejects floats and integers outside ±9007199254740991. Later phases encode Godot floats as tagged strings under bridge protocol v1.

- [ ] **Step 4: Implement descriptor discovery and WebSocket pairing**

`descriptor_reader.gd` derives the known runtime directory and project-ID filename, rejects non-files and expired descriptors, and parses the strict schema. `bridge_client.gd` checks for a matching descriptor every 250 ms while disconnected, creates `WebSocketPeer` only after one appears, connects only to `ws://127.0.0.1:<port>/bridge`, polls in `_process`, sends the pair request once per descriptor nonce, and refuses all commands until the pair response validates. Polling stops immediately in `close()`.

```gdscript
func _process(_delta: float) -> void:
	if closed: return
	if socket == null:
		if Time.get_ticks_msec() >= next_descriptor_check_ms: _try_descriptor()
		return
	socket.poll()
	while socket.get_available_packet_count() > 0:
		if not socket.was_string_packet():
			close("binary_frame_rejected")
			return
		_handle_message(socket.get_packet().get_string_from_utf8())
```

After pairing, validate `serverProof` before accepting the session, delete the descriptor if present, retain only the derived session key, send signed `addon.ready` with project fingerprint, engine version, feature tags, addon hash, and plugin state, and zero the in-memory token byte array.

- [ ] **Step 5: Wire plugin lifecycle cleanup**

```gdscript
var bridge: GodotMcpBridgeClient

func _enter_tree() -> void:
	bridge = GodotMcpBridgeClient.new()
	add_child(bridge)
	bridge.start(GodotMcpDescriptorReader.read_project_identity())

func _exit_tree() -> void:
	if is_instance_valid(bridge):
		bridge.close("plugin_exit")
		bridge.queue_free()
```

No dock, autoload, debugger plugin, or mutation adapter is added in Phase 1.

- [ ] **Step 6: Run cross-language and real-editor tests**

Run:

```bash
node scripts/generate-godot-protocol.mjs --check
GODOT_BIN=/opt/homebrew/bin/godot pnpm test -- tests/integration/editor-pairing.test.ts
```

Expected: PASS; attachment identity matches and server shutdown causes clean addon disconnect without a stale descriptor.

- [ ] **Step 7: Commit**

```bash
git add addons/godot_mcp fixtures/godot-4.7/tests/protocol_fixture_test.gd tests/integration/editor-pairing.test.ts
git commit -m "feat: pair Godot editor addon securely"
```

## Task 11: Implement session service and Phase 1 doctor/help data

**Files:**
- Create: `packages/control-plane/src/session/sessionService.ts`
- Create: `packages/control-plane/src/session/sessionService.test.ts`
- Create: `packages/control-plane/src/help/coreHelp.ts`
- Modify: `packages/control-plane/src/index.ts`

**Interfaces:**
- Produces `SessionService.snapshot()`, `SessionService.capabilities()`, `SessionService.doctor()`, and `SessionService.help(operation?)`.
- Snapshot state is `starting | waiting_for_addon | attached | disconnected | closed`.

- [ ] **Step 1: Write failing state-transition and no-secret tests**

```ts
it("moves from waiting to attached without exposing credentials", async () => {
  const service = new SessionService(projectFixture, observeGrants, async () => healthyDoctorFixture);
  expect(service.snapshot().state).toBe("waiting_for_addon");
  service.onAttached(attachedFixture);
  const json = JSON.stringify(service.snapshot());
  expect(service.snapshot().state).toBe("attached");
  expect(json).not.toMatch(/token|sessionKey|authorization/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/control-plane/src/session/sessionService.test.ts`

Expected: FAIL because `SessionService` does not exist.

- [ ] **Step 3: Implement session snapshots, capabilities, doctor, and help**

Snapshot includes public product/protocol/Godot/addon versions, project ID, state, granted tiers/packs, attachment time, and last safe error code. Capabilities return only `core` operations in Phase 1. Doctor merges installation checks with live bridge/session checks but performs no mutation. Help accepts `session`, `capabilities`, `doctor`, or `help`; unknown names return `TARGET_NOT_FOUND`.

```ts
export class SessionService {
  private state: SessionState = "waiting_for_addon";
  private attached: PublicAttachment | null = null;

  constructor(
    private readonly project: ProjectIdentity,
    private readonly grants: SessionGrants,
    private readonly installationDoctor: () => Promise<DoctorResult>
  ) {}

  onAttached(value: PublicAttachment): void { this.attached = value; this.state = "attached"; }
  onDisconnected(): void { this.attached = null; this.state = "disconnected"; }
  snapshot(): PublicSessionSnapshot { return buildPublicSnapshot(this.project, this.grants, this.state, this.attached); }
  capabilities(): CapabilitySummary { return coreCapabilitySummary(this.grants); }
  doctor(): Promise<DoctorResult> { return mergeDoctor(this.installationDoctor(), this.snapshot()); }
  help(operation?: CoreHelpTopic): CoreHelp { return getCoreHelp(operation); }
}
```

`PublicAttachment` contains no token, descriptor content, WebSocket object, or derived session key. `mergeDoctor` awaits the installation promise before combining it with live state.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test -- packages/control-plane/src/session && pnpm --filter @godot-mcp/control-plane typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/session packages/control-plane/src/help packages/control-plane/src/index.ts
git commit -m "feat: add read-only session service"
```

## Task 12: Expose the initial MCP tools over stdio

**Files:**
- Create: `packages/mcp-server/src/toolResult.ts`
- Create: `packages/mcp-server/src/registerCoreTools.ts`
- Create: `packages/mcp-server/src/createServer.ts`
- Create: `packages/mcp-server/src/stdio.ts`
- Create: `packages/mcp-server/src/registerCoreTools.test.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/mcp-server/package.json`

**Interfaces:**
- Produces `createGodotMcpServer(deps): McpServer` and `connectStdio(server): Promise<void>`.
- Registers exactly four tools in Phase 1.
- Tests use `Client` from `@modelcontextprotocol/sdk/client/index.js` and `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js`.

- [ ] **Step 1: Write failing tool registration and annotation tests**

```ts
it("registers only the four Phase 1 read-only tools", async () => {
  const server = createGodotMcpServer(testDeps);
  const client = new Client({ name: "phase-1-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "godot_capabilities", "godot_doctor", "godot_help", "godot_session"
  ]);
  expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  await Promise.all([client.close(), server.close()]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/mcp-server/src/registerCoreTools.test.ts`

Expected: FAIL because the server factory does not exist.

- [ ] **Step 3: Implement tool registration with structured output**

Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.

```ts
server.registerTool("godot_session", {
  title: "Godot session status",
  description: "Read the attached Godot project, versions, state, and granted capabilities.",
  inputSchema: z.object({}),
  outputSchema: ToolResultSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => toMcpToolResult(await handlers.session()));
```

Repeat explicitly for capabilities, doctor, and help. Every handler calls `authorize` before the session service, writes an audit receipt on success or failure, and returns both `structuredContent` and a concise JSON text content item.

- [ ] **Step 4: Protect stdio and shutdown behavior**

`stdio.ts` must not use `console.log`. Install SIGINT/SIGTERM handlers that close MCP transport, bridge, descriptor, and audit sink once, then exit zero. Uncaught errors go to stderr and exit one after cleanup.

- [ ] **Step 5: Run tool tests and typecheck**

Run:

```bash
pnpm test -- packages/mcp-server
pnpm --filter @godot-mcp/mcp-server typecheck
```

Expected: PASS; invalid help operation returns a structured MCP error and an audit record.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server
git commit -m "feat: expose Phase 1 MCP tools"
```

## Task 13: Wire `godot-mcp connect` to bridge and MCP lifecycle

**Files:**
- Create: `packages/cli/src/commands/connect.ts`
- Create: `packages/cli/src/runtime/createRuntime.ts`
- Create: `packages/cli/src/runtime/createRuntime.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**
- `createRuntime({ project }): Promise<GodotMcpRuntime>` composes project identity, fixed Phase 1 grants, audit, bridge, session service, and MCP server. The `connect` command separately attaches stdio.
- `GodotMcpRuntime.close(reason)` is idempotent and removes an unconsumed descriptor.

- [ ] **Step 1: Write a failing composition and cleanup test**

```ts
it("creates observe-only runtime and removes its descriptor on close", async () => {
  const project = await initializedFixture();
  const runtime = await createRuntime({ project: project.root });
  expect(runtime.session.snapshot().grantedTiers).toEqual(["observe"]);
  expect(await pathExists(runtime.bridge.descriptorPath)).toBe(true);
  await runtime.close("test");
  expect(await pathExists(runtime.bridge.descriptorPath)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- packages/cli/src/runtime/createRuntime.test.ts`

Expected: FAIL because the runtime composer does not exist.

- [ ] **Step 3: Implement runtime composition**

Create services in this order: project identity, audit sink, session service, bridge server/descriptor, MCP server, stdio transport. On any startup failure, close already-created resources in reverse order. The only Phase 1 grants are `{ tiers: ["observe"], packs: ["core"] }`; reject CLI flags attempting broader grants.

```ts
export async function createRuntime(options: RuntimeOptions): Promise<GodotMcpRuntime> {
  const project = await readProjectIdentity(options.project);
  const audit = new JsonlAuditSink(auditPath(project));
  const grants: SessionGrants = { tiers: ["observe"], packs: ["core"] };
  const session = new SessionService(project, grants, () => runDoctor(project.rootRealPath));
  let bridge: BridgeServer | undefined;
  let mcp: McpServer | undefined;
  try {
    bridge = await startBridgeServer({ project, grants, audit, onAttached: (value) => session.onAttached(value) });
    mcp = createGodotMcpServer({ project, grants, audit, session });
    return new GodotMcpRuntime(project, audit, session, bridge, mcp);
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    throw error;
  }
}
```

`GodotMcpRuntime.close()` maintains its own close promise so concurrent signal/MCP shutdown paths share one reverse-order cleanup.

- [ ] **Step 4: Implement `connect` command**

Exact invocation:

```bash
godot-mcp connect --project /absolute/path/to/project
```

It validates an initialized healthy installation, starts the runtime, connects stdio, and remains alive until MCP disconnect or signal. It writes only protocol data to stdout. Human-readable startup state goes to stderr.

- [ ] **Step 5: Run focused tests and CLI smoke**

Run:

```bash
pnpm test -- packages/cli/src/runtime
pnpm --filter @godot-mcp/cli build
node packages/cli/dist/bin.js doctor --project fixtures/godot-4.7
```

Expected: unit tests PASS; doctor exits `4` before init and prints a structured unhealthy result without changing the fixture.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat: compose secure MCP runtime"
```

## Task 14: Add end-to-end phase gate, CI, and operator documentation

**Files:**
- Create: `tests/end-to-end/phase-0-1.test.ts`
- Create: `tests/security/pairing-hostile.test.ts`
- Create: `packages/testkit/src/e2e.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `scripts/qa-phase-0-1.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `docs/security/threat-model.md`
- Create: `docs/protocol/bridge-v1.md`
- Create: `docs/testing/phase-0-1.md`
- Create: `AGENTS.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces `pnpm qa:phase-0-1` as the authoritative Phase 0–1 completion command.
- Documents the current capability boundary without claiming later phases exist.
- Produces test-only `runCli(args)`, `launchEditor(project)`, and `launchMcpClient(args)` helpers. Each helper owns and closes only its spawned process.

- [ ] **Step 1: Write the failing stdio/editor end-to-end test**

The test must perform this exact flow:

```ts
const project = await copyFixture();
await runCli(["init", "--project", project.root]);
const editor = await launchEditor(project.root);
const client = await launchMcpClient(["connect", "--project", project.root]);
await waitUntil(() => client.callTool({ name: "godot_session", arguments: {} })
  .then((result) => result.structuredContent?.data?.state === "attached"));
expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
  "godot_capabilities", "godot_doctor", "godot_help", "godot_session"
]);
await client.close();
await editor.close();
await runCli(["disable", "--project", project.root]);
await runCli(["uninstall", "--project", project.root]);
expect(await project.diffFromOriginal()).toEqual([]);
```

Use the SDK `Client` and `StdioClientTransport`; do not parse MCP stdout manually.

Implement the three process helpers in `packages/testkit/src/e2e.ts`. `launchMcpClient` starts `node packages/cli/dist/bin.js ...` through `StdioClientTransport`; `launchEditor` uses the verified `GODOT_BIN`; `runCli` captures stdout/stderr and returns the exit code. All three enforce timeouts and include idempotent close methods.

- [ ] **Step 2: Run it to verify failure before final wiring**

Run: `GODOT_BIN=/opt/homebrew/bin/godot pnpm test -- tests/end-to-end/phase-0-1.test.ts`

Expected: FAIL at the first missing or incomplete end-to-end contract.

- [ ] **Step 3: Add hostile pairing tests**

Cover wrong token, wrong project UUID, changed `project.godot` hash, expired descriptor, replayed pair, repeated sequence, oversized frame, malformed JSON, connection before descriptor, two simultaneous clients, server death, editor death, and stale descriptor cleanup. Each rejection must assert a stable error code, no project change, and an audit receipt without secrets.

```ts
const attacks = [
  { attack: "wrong_token", expected: "AUTHENTICATION_FAILED" },
  { attack: "wrong_project", expected: "AUTHENTICATION_FAILED" },
  { attack: "changed_project_hash", expected: "PROJECT_CHANGED" },
  { attack: "expired_descriptor", expected: "AUTHENTICATION_FAILED" },
  { attack: "replayed_pair", expected: "AUTHENTICATION_FAILED" },
  { attack: "repeated_sequence", expected: "AUTHENTICATION_FAILED" },
  { attack: "oversized_frame", expected: "PAYLOAD_TOO_LARGE" },
  { attack: "malformed_json", expected: "INVALID_REQUEST" },
  { attack: "early_connection", expected: "AUTHENTICATION_FAILED" },
  { attack: "second_client", expected: "AUTHENTICATION_FAILED" }
] as const;

it.each(attacks)("rejects $attack without project mutation or secret leakage", async ({ attack, expected }) => {
  const harness = await HostilePairingHarness.create();
  const before = await harness.project.snapshot();
  const result = await harness.attempt(attack);
  expect(result.errorCode).toBe(expected);
  expect(await harness.project.snapshot()).toEqual(before);
  expect(JSON.stringify(await harness.auditRecords())).not.toMatch(harness.secretPattern);
  await harness.close();
});

it.each(["server_death", "editor_death", "stale_descriptor"] as const)(
  "recovers from %s idempotently", async (failure) => {
    const harness = await HostilePairingHarness.create();
    await harness.triggerFailure(failure);
    await harness.recover();
    await harness.recover();
    expect(await harness.ownedProcesses()).toEqual([]);
    expect(await harness.descriptors()).toEqual([]);
    await harness.close();
  }
);
```

Implement `HostilePairingHarness` in the same test file. `attempt` changes exactly the named token/identity/hash/deadline/sequence/frame/JSON/order condition; `triggerFailure` terminates only the harness-owned PID or writes one expired descriptor; `recover` calls the runtime cleanup/doctor path; `secretPattern` is built from the actual token and derived key, not generic words.

- [ ] **Step 4: Implement the phase gate script**

`scripts/qa-phase-0-1.mjs` runs, in order:

1. Generated protocol check.
2. Topological package builds.
3. ESLint.
4. TypeScript typecheck.
5. Unit tests.
6. Godot fixture import.
7. GDScript protocol fixture.
8. Real-editor integration tests.
9. Security tests.
10. End-to-end stdio/editor test.
11. `git diff --check`.

Stop on first failure and never report later checks as passed. Add root script `"qa:phase-0-1": "node scripts/qa-phase-0-1.mjs"`.

- [ ] **Step 5: Add macOS CI with a checksum-pinned Godot 4.7 download**

Use Node 22 and pnpm 11.13.0. Download:

```text
https://github.com/godotengine/godot-builds/releases/download/4.7-stable/Godot_v4.7-stable_macos.universal.zip
```

Verify SHA-512 exactly:

```text
0d5d635e6d78d4c2b1286586ca62af249609c2f70815b35437049f08476714d08b913faaf8c10f37313c932ee24c4f87a829899c84fa248f788fb612b8f79229
```

Run `pnpm install --frozen-lockfile`, unzip the engine, export `GODOT_BIN`, assert `4.7.stable.official.5b4e0cb0f`, then run `pnpm qa:phase-0-1`. CI uploads logs only on failure and never uploads pairing descriptors.

- [ ] **Step 6: Write operator and security documentation**

README quick start shows `pnpm install`, `pnpm build`, `godot-mcp init`, `doctor`, `disable`, and `uninstall`. For a source checkout, document this verified Codex registration shape with absolute paths:

```bash
codex mcp add godot -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project
```

State that a fresh Codex task is required after registration. Clearly label the four implemented tools and list later phases as roadmap, not current functionality.

Threat-model documentation states the same-user compromise boundary, token lifecycle, no-listener addon design, denied paths, audit redaction, and the fact that unsafe mode is not implemented in Phase 1. Protocol documentation includes pair request/response, signed envelope input, canonical JSON rule, sequence/deadline rules, close codes, and version rejection.

- [ ] **Step 7: Run the full phase gate twice**

Run:

```bash
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1
git status --short
```

Expected: both gates PASS; the second run proves cleanup/idempotency; `git status` contains only the intended task files before staging.

- [ ] **Step 8: Commit**

```bash
git add tests/end-to-end tests/security packages/testkit/src/e2e.ts packages/testkit/src/index.ts scripts/qa-phase-0-1.mjs .github/workflows/ci.yml docs/security docs/protocol docs/testing AGENTS.md README.md package.json
git commit -m "test: certify Phase 0 and secure attachment"
```

## Final implementation review checkpoint

After Task 14:

1. Compare the implementation against Sections 2, 4–15, 17, and Phase 0–1 in the master design.
2. Confirm the tool list contains exactly four tools and every one is annotated read-only.
3. Inspect the disposable project before/after hashes and the audit JSONL for secret leakage.
4. Confirm the addon opened no listener and the server bound only to `127.0.0.1`.
5. Confirm no autoload, runtime harness activation, mutation tools, input tools, debugger tools, or unsafe evaluation entered Phase 1.
6. Run `GODOT_BIN=/opt/homebrew/bin/godot pnpm qa:phase-0-1` once more after review changes.
7. Create a Phase 0–1 completion receipt listing commits, exact Godot/Node/pnpm versions, checks passed, checks skipped, and residual risks.

The next plan begins Phase 2 only after this gate is green and reviewed.
