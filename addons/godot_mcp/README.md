# Godot MCP addon

This editor addon is the Godot-side component of Godot MCP. Install and remove it with the `godot-mcp` CLI so its manifest, project identity, and reversible ownership checks remain intact.

The addon opens no functional listener. It connects outward to the authenticated, loopback-only bridge and does not provide arbitrary shell, host-filesystem, network, method-invocation, or GDScript-evaluation access in normal profiles.

See the project README and security threat model in the source release for setup, permissions, and support status.
