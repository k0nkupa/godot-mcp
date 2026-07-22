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
