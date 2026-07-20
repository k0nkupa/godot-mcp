import { z } from "zod";

import { appendSecureJournal, readSecureJournal } from "./secureJournalFile.js";

const MAX_BYTES = 4 * 1024 * 1024;
const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.uuid(),
  jobToken: z.string().regex(/^pjob_[A-Za-z0-9_-]{43}$/),
  sessionId: z.string().min(8).max(256),
  operation: z.enum(["import", "reimport", "run", "build", "export"]),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  pid: z.number().int().positive().optional(),
  fingerprint: z.string().min(3).max(256).optional(),
  artifactName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
  recovery: z.enum(["stopped", "missing", "ambiguous"]).optional(),
  artifactRecovery: z.enum(["not_applicable", "clean", "rejected", "absent"]).optional(),
  recordedAt: z.string().datetime(),
}).strict().refine((value) => (value.pid === undefined) === (value.fingerprint === undefined), "PID and fingerprint must appear together");

export type ProjectJobJournalSnapshot = z.infer<typeof SnapshotSchema>;

export class ProjectJobJournal {
  private readonly latest = new Map<string, ProjectJobJournalSnapshot>();
  private tail: Promise<unknown> = Promise.resolve();

  static async open(path: string): Promise<ProjectJobJournal> {
    const journal = new ProjectJobJournal(path);
    try {
      const text = await readSecureJournal(path, MAX_BYTES);
      if (text === null) return journal;
      for (const [index, line] of text.split("\n").entries()) {
        if (!line) continue;
        try { journal.remember(SnapshotSchema.parse(JSON.parse(line) as unknown)); }
        catch { throw new Error(`Project job journal record ${index + 1} is malformed`); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return journal;
  }

  private constructor(private readonly path: string) {}

  nonterminal(projectId: string): ProjectJobJournalSnapshot[] {
    return [...this.latest.values()].filter((record) => record.projectId === projectId && ["queued", "running"].includes(record.state));
  }

  async append(input: Omit<ProjectJobJournalSnapshot, "schemaVersion" | "recordedAt">): Promise<void> {
    const record = SnapshotSchema.parse({ ...input, schemaVersion: 1, recordedAt: new Date().toISOString() });
    const write = this.tail.then(async () => {
      await appendSecureJournal(this.path, `${JSON.stringify(record)}\n`);
      this.remember(record);
    });
    this.tail = write.catch(() => undefined);
    await write;
  }

  private remember(record: ProjectJobJournalSnapshot): void {
    this.latest.delete(record.jobToken);
    this.latest.set(record.jobToken, record);
    while (this.latest.size > 256) this.latest.delete(this.latest.keys().next().value as string);
  }
}
