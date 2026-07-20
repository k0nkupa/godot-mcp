import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(stderr || `${command} failed`)));
  });
}

const root = resolve(import.meta.dirname, "..");
const product = JSON.parse(await readFile(resolve(root, "packages/protocol/product.json"), "utf8"));
const matrix = JSON.parse(await readFile(resolve(root, "release/compatibility-matrix.json"), "utf8"));
const releaseWorkflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
for (const line of releaseWorkflow.split("\n")) {
  const action = line.match(/^\s*-?\s*uses:\s*[^@\s]+@([^\s#]+)/)?.[1];
  if (action && !/^[a-f0-9]{40}$/.test(action)) throw new Error(`Release action is not pinned to an immutable commit: ${line.trim()}`);
}
const tag = await run("git", ["describe", "--tags", "--exact-match", "HEAD"]);
if (tag !== `v${product.productVersion}`) throw new Error(`Release requires exact tag v${product.productVersion}; detected ${tag}`);
if (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Release requires a clean checkout");
const remote = await run("git", ["remote", "get-url", "origin"]);
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(remote)) throw new Error("Release requires an HTTPS GitHub origin");
const repository = remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
const certified = matrix.cells.filter((cell) => cell.state === "certified");
if (certified.length === 0) throw new Error("Release requires at least one certified compatibility cell");
for (const cell of certified) {
  if (typeof cell.receipt !== "string" || !cell.receipt.startsWith("release/receipts/")) throw new Error("Certified compatibility cells require repository receipts");
  const receipt = JSON.parse(await readFile(resolve(root, cell.receipt), "utf8"));
  const sameCell = receipt?.cell?.godot === cell.godot && receipt.cell.exactVersion === cell.exactVersion && receipt.cell.platform === cell.platform && receipt.cell.architecture === cell.architecture;
  if (receipt?.schemaVersion !== 1 || receipt.result !== "passed" || receipt.gate !== "phase-11-cell" || !sameCell) throw new Error(`Compatibility receipt identity is invalid: ${cell.receipt}`);
  if (!/^[a-f0-9]{40}$/.test(receipt.sourceRevision) || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(receipt.workflowRunUrl)) throw new Error(`Compatibility receipt provenance is invalid: ${cell.receipt}`);
  if (!Array.isArray(receipt.stages) || receipt.stages.length !== 15 || receipt.stages.some((stage) => stage?.status !== "passed")) throw new Error(`Compatibility receipt stages are incomplete: ${cell.receipt}`);
  await run("gh", ["attestation", "verify", resolve(root, cell.receipt), "--repo", repository, "--signer-workflow", `${repository}/.github/workflows/compatibility.yml`, "--source-digest", receipt.sourceRevision, "--deny-self-hosted-runners"]);
  await run("git", ["merge-base", "--is-ancestor", receipt.sourceRevision, "HEAD"]);
  const laterPaths = (await run("git", ["diff", "--name-only", `${receipt.sourceRevision}..HEAD`])).split("\n").filter(Boolean);
  if (laterPaths.some((path) => path !== "release/compatibility-matrix.json" && !path.startsWith("release/receipts/"))) throw new Error(`Product code changed after compatibility certification: ${cell.receipt}`);
}
process.stdout.write(`${JSON.stringify({ releaseReady: true, tag, remote, certifiedCells: certified.length })}\n`);
