import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { buildRelease } from "../../scripts/release-contract.mjs";
import { expect, test } from "vitest";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => { const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", reject); child.once("close", (code) => done({ code: code ?? 1, stdout, stderr })); });
}

test("publication resumes after an exact partial npm and draft GitHub release", async () => {
  const root = await mkdtemp(join(tmpdir(), "godot-mcp-publish-test-")); const output = join(root, "out"); const bin = join(root, "bin"); const state = join(root, "state.json");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin)); await buildRelease({ root: resolve("."), output });
    const npm = `#!/usr/bin/env node
const fs=require("fs"),crypto=require("crypto"),p=process.env.RELEASE_STATE;let s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):{};const a=process.argv.slice(2);if(a[0]==="view"){s.pending=a[1];fs.writeFileSync(p,JSON.stringify(s));if(!s.npm?.[a[1]]){console.error("E404 Not Found");process.exit(1)}console.log(JSON.stringify(s.npm[a[1]]))}else if(a[0]==="publish"){const b=fs.readFileSync(a[1]);s.npm??={};s.npm[s.pending]="sha512-"+crypto.createHash("sha512").update(b).digest("base64");fs.writeFileSync(p,JSON.stringify(s));}else process.exit(2);`;
    const gh = `#!/usr/bin/env node
const fs=require("fs"),path=require("path"),p=process.env.RELEASE_STATE;let s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):{};const a=process.argv.slice(2),dir=p+"-assets";fs.mkdirSync(dir,{recursive:true});if(a[0]!=="release")process.exit(2);if(a[1]==="view"){if(!s.release){console.error("release not found");process.exit(1)}console.log(JSON.stringify({isDraft:s.release.draft,assets:s.release.assets.map(name=>({name}))}))}else if(a[1]==="create"){s.release={draft:true,assets:[]};fs.writeFileSync(p,JSON.stringify(s))}else if(a[1]==="upload"){const f=a[3],name=path.basename(f);fs.copyFileSync(f,path.join(dir,name));if(!s.release.assets.includes(name))s.release.assets.push(name);fs.writeFileSync(p,JSON.stringify(s))}else if(a[1]==="download"){const name=a[a.indexOf("--pattern")+1],to=a[a.indexOf("--dir")+1];fs.copyFileSync(path.join(dir,name),path.join(to,name))}else if(a[1]==="edit"){s.release.draft=false;fs.writeFileSync(p,JSON.stringify(s))}else process.exit(2);`;
    await Promise.all([["npm", npm], ["gh", gh]].map(async ([name, source]) => { const path = join(bin, name!); await writeFile(path, source!, { mode: 0o700 }); await chmod(path, 0o700); }));
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, RELEASE_STATE: state };
    const first = await run(process.execPath, ["scripts/publish-release.mjs", output], env); expect(first, first.stderr).toMatchObject({ code: 0 });
    const second = await run(process.execPath, ["scripts/publish-release.mjs", output], env); expect(second, second.stderr).toMatchObject({ code: 0 }); expect(second.stdout).toContain("npm already exact");
    expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({ release: { draft: false }, npm: expect.any(Object) });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
