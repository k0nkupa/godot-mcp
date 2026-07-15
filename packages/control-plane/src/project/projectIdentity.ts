import { createHash, randomUUID } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ProjectIdentity } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import { createProjectConfig } from "./projectConfig.js";

export interface DiscoveredProject {
  rootRealPath: string;
  projectFileRealPath: string;
}

function invalidProject(message: string): GodotMcpException {
  return new GodotMcpException({
    code: "INVALID_REQUEST",
    message,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

export async function discoverProject(inputPath: string): Promise<DiscoveredProject> {
  let inputMetadata;
  try {
    inputMetadata = await stat(inputPath);
  } catch {
    throw invalidProject("The supplied Godot project path does not exist");
  }

  let rootInput: string;
  if (inputMetadata.isDirectory()) {
    rootInput = inputPath;
  } else if (inputMetadata.isFile() && basename(inputPath) === "project.godot") {
    rootInput = dirname(inputPath);
  } else {
    throw invalidProject("Supply a Godot project directory or its project.godot file");
  }

  const rootRealPath = await realpath(rootInput);
  const projectFile = join(rootRealPath, "project.godot");
  let projectMetadata;
  try {
    projectMetadata = await stat(projectFile);
  } catch {
    throw invalidProject("The supplied directory does not contain project.godot");
  }
  if (!projectMetadata.isFile()) {
    throw invalidProject("project.godot must be a regular file");
  }

  return { rootRealPath, projectFileRealPath: await realpath(projectFile) };
}

export async function readProjectIdentity(root: string): Promise<ProjectIdentity> {
  const project = await discoverProject(root);
  const config = await createProjectConfig(project.rootRealPath);
  const projectContents = await readFile(project.projectFileRealPath);

  return {
    projectId: config.projectId,
    rootRealPath: project.rootRealPath,
    projectConfigSha256: createHash("sha256").update(projectContents).digest("hex"),
  };
}
