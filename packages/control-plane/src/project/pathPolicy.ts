import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative as relativePath, resolve, sep } from "node:path";

import type { ProjectIdentity } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";

export type ProjectPathMode = "read" | "write";

const CREDENTIAL_FILENAME = /(?:credential|secret|token|api[-_.]?key|private[-_.]?key|id_rsa)/i;

function pathDenied(resourcePath: string): GodotMcpException {
  return new GodotMcpException({
    code: "PATH_DENIED",
    message: `Project path is denied: ${resourcePath}`,
    retryable: false,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

function isContained(root: string, target: string): boolean {
  const relative = relativePath(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${sep}`) && !isAbsolute(relative));
}

async function nearestExistingRealParent(candidate: string, root: string): Promise<string> {
  let current = candidate;
  while (isContained(root, current)) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (current === root) {
      break;
    }
    current = dirname(current);
  }
  throw pathDenied(candidate);
}

export async function resolveProjectPath(
  identity: ProjectIdentity,
  resPath: string,
  mode: ProjectPathMode,
): Promise<string> {
  if (!resPath.startsWith("res://") || resPath.includes("\0")) {
    throw pathDenied(resPath);
  }

  const relative = resPath.slice("res://".length);
  const parts = relative.split("/");
  if (
    relative.length === 0 ||
    isAbsolute(relative) ||
    parts.some(
      (part) =>
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /^\.env(?:\.|$)/i.test(part) ||
        CREDENTIAL_FILENAME.test(part),
    )
  ) {
    throw pathDenied(resPath);
  }

  const candidate = resolve(identity.rootRealPath, relative);
  if (!isContained(identity.rootRealPath, candidate)) {
    throw pathDenied(resPath);
  }

  let anchor: string;
  try {
    anchor =
      mode === "read"
        ? await realpath(candidate)
        : await nearestExistingRealParent(candidate, identity.rootRealPath);
  } catch (error) {
    if (error instanceof GodotMcpException) {
      throw error;
    }
    throw pathDenied(resPath);
  }

  if (!isContained(identity.rootRealPath, anchor)) {
    throw pathDenied(resPath);
  }
  return candidate;
}
