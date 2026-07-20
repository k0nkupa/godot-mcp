import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { copyFixture } from "@godot-mcp/testkit";
import { expect, it } from "vitest";

import { ProjectJobJournal } from "./projectJobJournal.js";

it("recovers only the latest nonterminal project job snapshots", async () => {
  const project = await copyFixture();
  const token = `pjob_${"A".repeat(43)}`;
  const projectId = "019f75d0-1234-7abc-8def-0123456789ab";
  try {
    const path = join(project.root, ".godot/evidence/godot-mcp/project-jobs.jsonl");
    const journal = await ProjectJobJournal.open(path);
    await journal.append({ projectId, jobToken: token, sessionId: "session_12345678", operation: "export", state: "running", pid: 123, fingerprint: "123:owned", artifactName: "fixture" });
    expect((await ProjectJobJournal.open(path)).nonterminal(projectId)).toEqual([expect.objectContaining({ jobToken: token, pid: 123, fingerprint: "123:owned" })]);
    await journal.append({ projectId, jobToken: token, sessionId: "session_12345678", operation: "export", state: "failed", pid: 123, fingerprint: "123:owned", artifactName: "fixture", recovery: "stopped", artifactRecovery: "absent" });
    expect((await ProjectJobJournal.open(path)).nonterminal(projectId)).toEqual([]);
  } finally { await project.cleanup(); }
});

it("rejects a symlinked journal instead of following it", async () => {
  const project = await copyFixture();
  try {
    const path = join(project.root, ".godot/evidence/godot-mcp/project-jobs.jsonl");
    await ProjectJobJournal.open(path);
    await symlink(join(project.root, "project.godot"), path);
    await expect(ProjectJobJournal.open(path)).rejects.toThrow(/non-symlink/i);
  } finally { await project.cleanup(); }
});
