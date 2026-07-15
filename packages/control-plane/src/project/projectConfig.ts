import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PRODUCT_VERSION } from "@godot-mcp/protocol";
import { z } from "zod";

import { GodotMcpException } from "../errors.js";
import { discoverProject } from "./projectIdentity.js";

export const ProjectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.uuid(),
  addonVersion: z.literal(PRODUCT_VERSION),
  allowedResourceRoots: z.array(z.string()).default(["res://"]),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

function invalidConfig(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "INVALID_REQUEST",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

async function readExistingConfig(path: string): Promise<ProjectConfig> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw invalidConfig(".godot-mcp.json must be a regular project-local file");
  }

  try {
    return ProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof GodotMcpException) {
      throw error;
    }
    throw invalidConfig(".godot-mcp.json is not a valid Godot MCP project configuration");
  }
}

export async function createProjectConfig(root: string): Promise<ProjectConfig> {
  const project = await discoverProject(root);
  const path = join(project.rootRealPath, ".godot-mcp.json");
  const config = ProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId: randomUUID(),
    addonVersion: PRODUCT_VERSION,
    allowedResourceRoots: ["res://"],
  });

  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return readExistingConfig(path);
  }
}
