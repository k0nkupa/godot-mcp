# AI agent setup design

## Goal

Give users a short prompt they can paste into an AI coding agent to install and register Godot MCP safely, following the onboarding pattern used by Meraki Connect.

## Documentation structure

The README will add a **Set up with an AI coding agent** section near the top. It will contain one copyable prompt that directs the agent to the raw GitHub URL for `setup-instructions/setup.md`.

The dedicated setup guide will be the source of truth for agent-led installation. Keeping detailed instructions outside the README avoids duplicating the existing source quick start and allows the agent workflow to evolve independently.

## Setup workflow

The guide will instruct the agent to:

1. Confirm the host is macOS and check Node.js 22, pnpm 11.13.0, and Godot 4.7 stable.
2. Ask the user for the absolute path to the target Godot project.
3. Install locked dependencies and build Godot MCP from the source checkout.
4. Run `init` and `doctor` against the target project.
5. Register the observe-only MCP server with an absolute CLI path.
6. Explain runtime, input, and editor capabilities as separate optional registrations, and require explicit user approval before enabling any of them.
7. Tell the user to start a fresh Codex task after registration.
8. Verify the resulting configuration and report exact successes, failures, and skipped checks.

## Safety boundaries

- Observe-only registration is the default.
- The agent must not enable runtime control, input automation, or project mutation without explicit approval.
- The agent must not claim unsupported operating systems or Godot versions as certified.
- The agent must preserve independently modified addon or project files and surface refusal errors instead of bypassing them.
- The agent must not launch or automate a game runtime unless the user separately approves the required grants and action.

## Validation

- Confirm the README prompt points to the raw `main` branch setup guide.
- Confirm every command and flag matches the CLI help and the existing README quick start.
- Run the focused workspace metadata test and documentation link/reference checks.
- No full phase gate is required because this change does not modify runtime or product code.
