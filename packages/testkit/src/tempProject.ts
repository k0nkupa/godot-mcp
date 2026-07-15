import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export interface TempProject {
  root: string;
  cleanup(): Promise<void>;
  diffFromOriginal(): Promise<string[]>;
}

async function fileMap(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".godot") {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const contents = await readFile(absolute);
        files.set(relative(root, absolute), createHash("sha256").update(contents).digest("hex"));
      }
    }
  }

  await visit(root);
  return files;
}

export async function copyFixture(
  fixtureRoot = resolve(process.cwd(), "fixtures/godot-4.7"),
): Promise<TempProject> {
  const container = await mkdtemp(join(tmpdir(), "godot-mcp-fixture-"));
  const root = join(container, "project");
  await cp(fixtureRoot, root, { recursive: true, errorOnExist: true });
  const original = await fileMap(root);

  return {
    root,
    async cleanup(): Promise<void> {
      await rm(container, { force: true, recursive: true });
    },
    async diffFromOriginal(): Promise<string[]> {
      const current = await fileMap(root);
      const paths = new Set([...original.keys(), ...current.keys()]);
      return [...paths]
        .filter((path) => original.get(path) !== current.get(path))
        .sort((left, right) => left.localeCompare(right));
    },
  };
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}
