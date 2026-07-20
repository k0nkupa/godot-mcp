import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

function command(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, args, { stdio: ["ignore", "pipe", "pipe"], ...options }); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function tarPackageIdentity(bytes) {
  const archive = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = text(0, 100); const size = Number.parseInt(text(124, 12).trim() || "0", 8); const bodyStart = offset + 512;
    if (name === "package/package.json") { const value = JSON.parse(archive.subarray(bodyStart, bodyStart + size).toString("utf8")); if (typeof value.name !== "string" || typeof value.version !== "string") throw new Error("Packed npm identity is invalid"); return { name: value.name, version: value.version }; }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("Packed npm package.json is missing");
}

async function publishNpmArtifacts(output, manifest) {
  for (const artifact of manifest.artifacts.filter((entry) => entry.name.endsWith(".tgz"))) {
    const path = join(output, artifact.name); const bytes = await readFile(path); const identity = tarPackageIdentity(bytes); const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const existing = await command("npm", ["view", `${identity.name}@${identity.version}`, "dist.integrity", "--json"]);
    if (existing.code === 0) {
      if (JSON.parse(existing.stdout) !== expectedIntegrity) throw new Error(`Published npm artifact differs from release set: ${identity.name}@${identity.version}`);
      process.stdout.write(`npm already exact: ${identity.name}@${identity.version}\n`); continue;
    }
    if (!/E404|404 Not Found/i.test(existing.stderr)) throw new Error(`Unable to inspect npm publication state: ${existing.stderr}`);
    const published = await command("npm", ["publish", path, "--access", "public", "--provenance"]); if (published.code !== 0) throw new Error(`npm publish failed for ${artifact.name}: ${published.stderr}`);
  }
}

async function ensureGithubDraft(output, manifest) {
  const tag = `v${manifest.version}`; let view = await command("gh", ["release", "view", tag, "--json", "assets,isDraft"]);
  if (view.code !== 0) {
    if (!/release not found|HTTP 404/i.test(view.stderr)) throw new Error(`Unable to inspect GitHub release: ${view.stderr}`);
    const created = await command("gh", ["release", "create", tag, "--verify-tag", "--draft", "--generate-notes", "--title", tag]); if (created.code !== 0) throw new Error(`Unable to create draft GitHub release: ${created.stderr}`);
    view = await command("gh", ["release", "view", tag, "--json", "assets,isDraft"]); if (view.code !== 0) throw new Error(`Unable to read draft GitHub release: ${view.stderr}`);
  }
  const state = JSON.parse(view.stdout); const expected = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact])); expected.set("release-manifest.json", { name: "release-manifest.json", sha256: createHash("sha256").update(await readFile(join(output, "release-manifest.json"))).digest("hex") });
  const existingNames = new Set(state.assets.map((asset) => asset.name)); for (const name of existingNames) if (!expected.has(name)) throw new Error(`GitHub release contains an unmanifested asset: ${name}`);
  const download = await mkdtemp(join(tmpdir(), "godot-mcp-release-assets-"));
  try {
    for (const [name, artifact] of expected) {
      const path = join(output, name);
      if (existingNames.has(name)) {
        const downloaded = await command("gh", ["release", "download", tag, "--pattern", name, "--dir", download]); if (downloaded.code !== 0) throw new Error(`Unable to verify existing GitHub asset ${name}: ${downloaded.stderr}`);
        const digest = createHash("sha256").update(await readFile(join(download, name))).digest("hex"); if (digest !== artifact.sha256) throw new Error(`Existing GitHub asset differs from release set: ${name}`);
      } else {
        const uploaded = await command("gh", ["release", "upload", tag, path]); if (uploaded.code !== 0) throw new Error(`Unable to upload GitHub asset ${name}: ${uploaded.stderr}`);
      }
    }
  } finally { await rm(download, { recursive: true, force: true }); }
  return tag;
}

const output = resolve(process.argv[2] ?? "release/out"); const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8"));
const expectedFiles = [...manifest.artifacts.map((artifact) => artifact.name), "release-manifest.json"].sort(); if (JSON.stringify((await readdir(output)).sort()) !== JSON.stringify(expectedFiles)) throw new Error("Release output differs from its manifest");
const tag = await ensureGithubDraft(output, manifest); await publishNpmArtifacts(output, manifest); const published = await command("gh", ["release", "edit", tag, "--draft=false", "--verify-tag"]); if (published.code !== 0) throw new Error(`Unable to publish GitHub release: ${published.stderr}`);
process.stdout.write(`${JSON.stringify({ published: true, tag, artifacts: manifest.artifacts.length })}\n`);
