import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const PACKAGE_DIRS = ["protocol", "control-plane", "bridge-client", "mcp-server", "cli"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readCompatibilityMatrix(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  assert(value?.schemaVersion === 1 && typeof value.productVersion === "string" && Array.isArray(value.cells), "Compatibility matrix shape is invalid");
  const identities = new Set();
  for (const cell of value.cells) {
    assert(["4.4", "4.5", "4.6", "4.7"].includes(cell.godot), "Compatibility matrix has an unsupported Godot line");
    assert(["linux", "macos", "windows"].includes(cell.platform), "Compatibility matrix has an unsupported platform");
    assert(["x64", "arm64"].includes(cell.architecture), "Compatibility matrix has an unsupported architecture");
    assert(["pending", "certified"].includes(cell.state) && cell.gate === "phase-11-cell", "Compatibility cell state or gate is invalid");
    assert(cell.state !== "certified" || (typeof cell.exactVersion === "string" && typeof cell.receipt === "string"), "Certified cells require exact version and receipt");
    const identity = `${cell.godot}/${cell.platform}/${cell.architecture}`;
    assert(!identities.has(identity), `Duplicate compatibility cell: ${identity}`);
    identities.add(identity);
  }
  return value;
}

async function filesUnder(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      assert(!metadata.isSymbolicLink(), `Release source contains symlink: ${path}`);
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error(`Release source contains non-regular entry: ${path}`);
    }
  }
  await visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }

async function deterministicZip(sourceRoot, prefix, destination) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const path of await filesUnder(sourceRoot)) {
    const name = Buffer.from(`${prefix}/${relative(sourceRoot, path).replaceAll("\\", "/")}`);
    const data = await readFile(path);
    const crc = crc32(data);
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
    local.push(header, data);
    central.push(Buffer.concat([u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0x81a40000), u32(offset), name]));
    offset += header.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralBytes.length), u32(offset), u16(0)]);
  await writeFile(destination, Buffer.concat([...local, centralBytes, end]));
}

async function run(command, args, cwd, env = process.env) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed: ${stderr}`)));
  });
}

async function sourceRevision(root) {
  return await new Promise((resolvePromise) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolvePromise("unknown"));
    child.once("close", (code) => resolvePromise(code === 0 ? stdout.trim() : "unknown"));
  });
}

async function sourceDirty(root) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(stdout.length > 0) : reject(new Error(stderr || "Unable to inspect release source state")));
  });
}

async function stageAndPackPackage(root, packageDir, version, output, stagingRoot) {
  const source = join(root, "packages", packageDir);
  const staged = join(stagingRoot, packageDir);
  await mkdir(staged, { recursive: true });
  const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  assert(packageJson.version === version, `${packageJson.name} version differs from product version`);
  assert(await lstat(join(source, "dist")).then((value) => value.isDirectory(), () => false), `${packageJson.name} has no built dist directory`);
  const rewrite = (dependencies = {}) => Object.fromEntries(Object.entries(dependencies).map(([name, range]) => [name, typeof range === "string" && range.startsWith("workspace:") ? version : range]));
  delete packageJson.private;
  packageJson.license = "MIT";
  packageJson.engines = { node: ">=22 <23" };
  const extras = [];
  for (const file of (packageJson.files ?? []).filter((file) => file !== "dist")) {
    if (await lstat(join(source, file)).then(() => true, () => false)) extras.push(file);
  }
  packageJson.files = ["dist", "README.md", "LICENSE", ...extras];
  packageJson.dependencies = rewrite(packageJson.dependencies);
  delete packageJson.devDependencies;
  await writeFile(join(staged, "package.json"), json(packageJson));
  await cp(join(source, "dist"), join(staged, "dist"), { recursive: true });
  await cp(join(root, "README.md"), join(staged, "README.md"));
  await cp(join(root, "LICENSE"), join(staged, "LICENSE"));
  for (const path of await filesUnder(join(staged, "dist"))) {
    if (/\.test\.(?:js|d\.ts)(?:\.map)?$/.test(path)) await rm(path);
  }
  for (const extra of extras) {
    await cp(join(source, extra), join(staged, extra), { recursive: true });
  }
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--ignore-scripts", "--pack-destination", output],
    staged,
    { ...process.env, npm_config_cache: join(stagingRoot, ".npm-cache"), npm_config_update_notifier: "false" },
  );
  return { name: packageJson.name, version };
}

export async function buildRelease({ root, output }) {
  root = resolve(root);
  output = resolve(output);
  const revision = await sourceRevision(root);
  const dirty = await sourceDirty(root);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const product = JSON.parse(await readFile(join(root, "packages/protocol/product.json"), "utf8"));
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const plugin = await readFile(join(root, "addons/godot_mcp/plugin.cfg"), "utf8");
  assert(rootPackage.version === product.productVersion, "Root and product versions differ");
  assert(plugin.includes(`version=\"${product.productVersion}\"`), "Addon and product versions differ");
  const matrix = await readCompatibilityMatrix(join(root, "release/compatibility-matrix.json"));
  assert(matrix.productVersion === product.productVersion, "Compatibility and product versions differ");

  const version = product.productVersion;
  await deterministicZip(join(root, "addons/godot_mcp"), "addons/godot_mcp", join(output, `godot-mcp-addon-${version}.zip`));
  const stagingRoot = await mkdtemp(join(tmpdir(), "godot-mcp-release-stage-"));
  const components = [];
  try {
    for (const packageDir of PACKAGE_DIRS) components.push(await stageAndPackPackage(root, packageDir, version, output, stagingRoot));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  const external = new Map();
  for (const packageDir of PACKAGE_DIRS) {
    const packageJson = JSON.parse(await readFile(join(root, "packages", packageDir, "package.json"), "utf8"));
    for (const [name, dependencyVersion] of Object.entries(packageJson.dependencies ?? {})) {
      if (!String(dependencyVersion).startsWith("workspace:")) external.set(`${name}@${dependencyVersion}`, { type: "library", name, version: dependencyVersion, purl: `pkg:npm/${encodeURIComponent(name)}@${dependencyVersion}` });
    }
  }
  const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "godot-mcp", version } }, components: [...components.map((component) => ({ type: "library", ...component, purl: `pkg:npm/${encodeURIComponent(component.name)}@${version}` })), ...[...external.values()].sort((a, b) => a.name.localeCompare(b.name))] };
  await writeFile(join(output, "sbom.cdx.json"), json(sbom));
  const payloadNames = (await readdir(output)).sort();
  const payload = await Promise.all(payloadNames.map(async (name) => { const bytes = await readFile(join(output, name)); return { name, sha256: sha256(bytes), bytes: bytes.length }; }));
  await writeFile(join(output, "SHA256SUMS"), payload.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n") + "\n");
  const checksumBytes = await readFile(join(output, "SHA256SUMS"));
  const manifest = {
    schemaVersion: 1,
    version,
    bridgeProtocolVersion: product.bridgeProtocolVersion,
    sourceRevision: revision,
    sourceDirty: dirty,
    compatibilityMatrixSha256: sha256(await readFile(join(root, "release/compatibility-matrix.json"))),
    advertisedCompatibility: matrix.cells.filter((cell) => cell.state === "certified").map(({ godot, exactVersion, platform, architecture, receipt }) => ({ godot, exactVersion, platform, architecture, receipt })),
    artifacts: [...payload, { name: "SHA256SUMS", sha256: sha256(checksumBytes), bytes: checksumBytes.length }],
  };
  await writeFile(join(output, "release-manifest.json"), json(manifest));
  return manifest;
}

export async function verifyRelease(output) {
  output = resolve(output);
  const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8"));
  assert(manifest?.schemaVersion === 1 && typeof manifest.version === "string" && Array.isArray(manifest.artifacts), "Release manifest shape is invalid");
  assert(typeof manifest.sourceDirty === "boolean", "Release manifest source state is invalid");
  const expectedNames = new Set(manifest.artifacts.map((artifact) => artifact.name));
  assert(expectedNames.size === manifest.artifacts.length, "Release manifest has duplicate artifact names");
  const actualNames = (await readdir(output)).sort();
  assert(JSON.stringify(actualNames) === JSON.stringify([...expectedNames, "release-manifest.json"].sort()), "Release output contains missing or unmanifested artifacts");
  for (const artifact of manifest.artifacts) {
    assert(!artifact.name.includes("/") && !artifact.name.includes("\\"), "Release artifact name is unsafe");
    const bytes = await readFile(join(output, artifact.name));
    assert(bytes.length === artifact.bytes, `Artifact size mismatch: ${artifact.name}`);
    assert(sha256(bytes) === artifact.sha256, `Artifact hash mismatch: ${artifact.name}`);
  }
  const tgz = manifest.artifacts.filter((artifact) => artifact.name.endsWith(".tgz"));
  assert(tgz.length === PACKAGE_DIRS.length, "Release must contain exactly five npm tarballs");
  for (const artifact of tgz) {
    const archive = gunzipSync(await readFile(join(output, artifact.name)));
    const entries = new Map();
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const readString = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
      const name = readString(0, 100);
      const size = Number.parseInt(readString(124, 12).trim() || "0", 8);
      const type = readString(156, 1) || "0";
      assert(type === "0", `npm tarball contains non-regular entry: ${name}`);
      assert(name.startsWith("package/") && !name.includes("..") && !name.includes("\\"), `npm tarball contains unsafe path: ${name}`);
      const bodyStart = offset + 512;
      entries.set(name, archive.subarray(bodyStart, bodyStart + size));
      offset = bodyStart + Math.ceil(size / 512) * 512;
    }
    const packedJsonBytes = entries.get("package/package.json");
    assert(packedJsonBytes, `npm tarball has no package.json: ${artifact.name}`);
    const packedJson = JSON.parse(packedJsonBytes.toString("utf8"));
    assert(packedJson.version === manifest.version && packedJson.private !== true, `npm tarball version/private metadata is invalid: ${artifact.name}`);
    assert(packedJson.license === "MIT" && entries.has("package/README.md") && entries.has("package/LICENSE"), `npm tarball distribution metadata is incomplete: ${artifact.name}`);
    assert(!JSON.stringify(packedJson.dependencies ?? {}).includes("workspace:"), `npm tarball contains workspace dependency: ${artifact.name}`);
    assert(![...entries.keys()].some((name) => /\.test\.(?:js|d\.ts)(?:\.map)?$/.test(name)), `npm tarball contains compiled tests: ${artifact.name}`);
    if (packedJson.name === "@godot-mcp/cli") {
      assert(packedJson.bin?.["godot-mcp"] === "./dist/bin.js", "CLI tarball omits its godot-mcp executable mapping");
      assert(entries.has("package/godot/plugin_state.gd"), "CLI tarball omits its Godot plugin-state helper");
    }
  }
  const checksumLines = (await readFile(join(output, "SHA256SUMS"), "utf8")).trim().split("\n");
  const checksums = new Map(checksumLines.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    assert(match, "SHA256SUMS contains an invalid line");
    return [match[2], match[1]];
  }));
  const checksumArtifacts = manifest.artifacts.filter((artifact) => artifact.name !== "SHA256SUMS");
  assert(checksums.size === checksumArtifacts.length && checksumArtifacts.every((artifact) => checksums.get(artifact.name) === artifact.sha256), "SHA256SUMS does not exactly match release artifacts");

  const zipArtifacts = manifest.artifacts.filter((artifact) => artifact.name.endsWith(".zip"));
  assert(zipArtifacts.length === 1, "Release must contain exactly one addon ZIP");
  const zip = await readFile(join(output, zipArtifacts[0].name));
  const zipEntries = new Map();
  for (let offset = 0; offset + 4 <= zip.length;) {
    const signature = zip.readUInt32LE(offset);
    if (signature === 0x02014b50) break;
    assert(signature === 0x04034b50 && offset + 30 <= zip.length, "Addon ZIP local header is invalid");
    const flags = zip.readUInt16LE(offset + 6); const compression = zip.readUInt16LE(offset + 8); const expectedCrc = zip.readUInt32LE(offset + 14); const compressedSize = zip.readUInt32LE(offset + 18); const uncompressedSize = zip.readUInt32LE(offset + 22); const nameLength = zip.readUInt16LE(offset + 26); const extraLength = zip.readUInt16LE(offset + 28);
    assert(flags === 0x0800 && compression === 0 && compressedSize === uncompressedSize, "Addon ZIP must use deterministic stored UTF-8 entries");
    const nameStart = offset + 30; const dataStart = nameStart + nameLength + extraLength; const dataEnd = dataStart + compressedSize;
    assert(dataEnd <= zip.length, "Addon ZIP entry exceeds archive bounds");
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    assert(name.startsWith("addons/godot_mcp/") && !name.includes("..") && !name.includes("\\") && !zipEntries.has(name), `Addon ZIP contains an unsafe or duplicate path: ${name}`);
    const data = zip.subarray(dataStart, dataEnd); assert(crc32(data) === expectedCrc, `Addon ZIP CRC mismatch: ${name}`); zipEntries.set(name, data); offset = dataEnd;
  }
  const plugin = zipEntries.get("addons/godot_mcp/plugin.cfg");
  assert(plugin?.toString("utf8").includes(`version=\"${manifest.version}\"`), "Addon ZIP version differs from release manifest");
  assert(zipEntries.has("addons/godot_mcp/README.md") && zipEntries.has("addons/godot_mcp/LICENSE"), "Addon ZIP distribution metadata is incomplete");
  return manifest;
}
