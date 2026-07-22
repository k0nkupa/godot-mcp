# AI Agent Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a copyable README prompt that sends an AI coding agent to a safe, complete Godot MCP setup guide.

**Architecture:** Keep the README entry short and link it to a raw GitHub setup document, matching the Meraki Connect onboarding pattern. Make `setup-instructions/setup.md` the detailed source of truth, with observe-only registration as the default and explicit approval gates for runtime, input, and editor grants.

**Tech Stack:** Markdown, Node.js 22, pnpm 11.13.0, Godot 4.7 stable, Codex CLI, Vitest.

## Global Constraints

- macOS is the currently certified platform.
- Require Node.js 22, pnpm 11.13.0, and Godot 4.7 stable.
- Register only the six-tool observe-only MCP surface by default.
- Require explicit user approval before adding `runtime_control`, `input`, or `project_mutate` capabilities.
- Use absolute paths for the Godot MCP CLI and target Godot project.
- Never claim skipped or failed checks passed.
- Preserve independently modified addon and project files; do not bypass refusal checks.

---

### Task 1: Add and verify AI-agent onboarding

**Files:**
- Create: `setup-instructions/setup.md`
- Modify: `README.md`
- Modify: `tests/meta/workspace.test.ts`
- Reference: `docs/designs/2026-07-22-ai-agent-setup-design.md`

**Interfaces:**
- Consumes: Existing CLI commands in `packages/cli/src/bin.ts` and the source quick start in `README.md`.
- Produces: A stable raw URL at `https://raw.githubusercontent.com/k0nkupa/godot-mcp/main/setup-instructions/setup.md` and an agent workflow whose default registration name is `godot`.

- [ ] **Step 1: Add failing documentation-contract assertions**

Add this test to `tests/meta/workspace.test.ts` inside the existing `describe("workspace package contract", ...)` block:

```ts
  it("publishes safe AI-agent setup instructions", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("## Set up with an AI coding agent");
    expect(readme).toContain("https://raw.githubusercontent.com/k0nkupa/godot-mcp/main/setup-instructions/setup.md");

    const setup = await readFile("setup-instructions/setup.md", "utf8");
    expect(setup).toContain("codex mcp add godot -- node");
    expect(setup).toContain("explicit approval");
    expect(setup).toContain("--grant runtime_control --pack runtime");
    expect(setup).toContain("--grant project_mutate --pack editor");
  });
```

- [ ] **Step 2: Run the focused test and confirm the new contract fails**

Run:

```bash
pnpm vitest run tests/meta/workspace.test.ts
```

Expected: FAIL because `README.md` does not contain the new section and `setup-instructions/setup.md` does not exist.

- [ ] **Step 3: Add the README entry point**

Insert this section after the opening Godot MCP description and before `## Requirements`:

````markdown
## Set up with an AI coding agent

Copy this prompt and paste it into your AI coding agent:

```text
Set up Godot MCP by following these instructions:
https://raw.githubusercontent.com/k0nkupa/godot-mcp/main/setup-instructions/setup.md
```

The agent will check compatibility and prerequisites, install the addon into your chosen Godot project, register the observe-only MCP server, and verify the setup. Runtime control, input automation, and project mutation remain separate opt-ins that require your explicit approval.
````

- [ ] **Step 4: Create the detailed setup guide**

Create `setup-instructions/setup.md` with these sections and exact behavior:

```markdown
# Set up Godot MCP with an AI coding agent

Follow this guide from a local Godot MCP source checkout. Be evidence-first: run each check, report its actual result, and never describe a skipped or failed check as successful.

## Safety rules

- Default to the observe-only `godot` registration.
- Obtain explicit approval before registering runtime control, input automation, or project mutation.
- Do not launch or automate a game runtime merely to complete setup.
- Do not bypass installation, upgrade, or uninstall refusals for independently modified files.
- Do not advertise an uncertified operating system or Godot version as supported.

## 1. Check prerequisites

Confirm that the host is macOS and that these commands report Node.js 22, pnpm 11.13.0, and Godot 4.7 stable:

```bash
uname -s
node --version
pnpm --version
/absolute/path/to/godot --version
```

If a prerequisite is missing or outside the certified versions, explain the mismatch and ask before installing or changing anything.

## 2. Confirm the target project

Ask the user for the absolute path to the Godot project. Confirm that `<project>/project.godot` exists. Also resolve and retain the absolute path to this Godot MCP checkout; all later registration commands must use absolute paths.

## 3. Install and build Godot MCP

From the Godot MCP checkout, run:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Stop and report the exact failing command if either command fails.

## 4. Install and inspect the addon

Run the following with the confirmed absolute paths:

```bash
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js init --project /absolute/path/to/godot-project
node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js doctor --project /absolute/path/to/godot-project
```

Do not overwrite or remove independently modified files if the CLI refuses the operation. Report the refusal and ask the user how to proceed.

## 5. Register the observe-only server

Register the default six-tool observe-only MCP surface:

```bash
codex mcp add godot -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project
codex mcp get godot
```

Tell the user to start a fresh Codex task after registration so the new MCP server is exposed.

## 6. Offer optional capability registrations

Explain that these registrations expand authority. Do not run any command in this section without the user's explicit approval for that capability.

Runtime inspection and control:

```bash
codex mcp add godot-runtime -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project --grant runtime_control --pack runtime
```

Runtime control plus input automation:

```bash
codex mcp add godot-runtime-input -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project --grant runtime_control --pack runtime --pack input
```

Bounded project mutation:

```bash
codex mcp add godot-editor -- node /absolute/path/to/godot-mcp/packages/cli/dist/bin.js connect --project /absolute/path/to/godot-project --grant project_mutate --pack editor
```

After any approved registration, run `codex mcp get <registration-name>` and remind the user to start a fresh Codex task.

## 7. Report completion

Summarize the detected versions, checkout path, project path, `init` result, `doctor` result, observe-only registration result, optional registrations actually approved, and any failed or skipped checks. Do not launch Godot or a game runtime unless the user separately asks you to.
```

- [ ] **Step 5: Run focused validation**

Run:

```bash
pnpm vitest run tests/meta/workspace.test.ts
git diff --check
rg -n "docs/superpowers|TBD|TODO|FIXME" README.md setup-instructions/setup.md tests/meta/workspace.test.ts
```

Expected: Vitest reports 11 passing tests, `git diff --check` prints nothing, and `rg` prints nothing.

- [ ] **Step 6: Review the final diff for permission boundaries**

Run:

```bash
git diff -- README.md setup-instructions/setup.md tests/meta/workspace.test.ts
```

Expected: The README defaults to observe-only, every expanded capability is presented as optional, and the guide requires explicit approval before any expanded registration.

- [ ] **Step 7: Commit the implementation**

Run:

```bash
git add README.md setup-instructions/setup.md tests/meta/workspace.test.ts docs/plans/2026-07-22-ai-agent-setup.md
git commit -m "docs: add AI agent setup guide"
```
