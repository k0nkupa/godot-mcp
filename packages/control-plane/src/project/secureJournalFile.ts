import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

async function assertSecureParent(path: string): Promise<void> {
  const parent = dirname(path);
  const marker = `${sep}.godot${sep}`;
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return;
  }
  let current = await realpath(path.slice(0, markerIndex));
  const controlled = parent.slice(markerIndex + 1).split(sep).filter(Boolean);
  for (const segment of controlled) {
    current = join(current, segment);
    let metadata = await lstat(current).catch(() => undefined);
    if (!metadata) {
      await mkdir(current, { mode: 0o700 });
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Journal parent may not contain symbolic links");
  }
}

export async function readSecureJournal(path: string, maxBytes: number): Promise<string | null> {
  await assertSecureParent(path);
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Journal must be a regular non-symlink file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("Journal permissions must be owner-only");
  if (metadata.size > maxBytes) throw new Error("Journal exceeds its byte limit");
  return readFile(path, "utf8");
}

export async function appendSecureJournal(path: string, line: string): Promise<void> {
  await assertSecureParent(path);
  const existing = await lstat(path).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o077) !== 0)) {
    throw new Error("Journal must remain an owner-only regular non-symlink file");
  }
  const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
}
