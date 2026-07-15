import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const productPath = fileURLToPath(new URL("../packages/protocol/product.json", import.meta.url));
const outputPath = fileURLToPath(
  new URL("../addons/godot_mcp/generated/protocol_constants.gd", import.meta.url),
);

const product = JSON.parse(await readFile(productPath, "utf8"));
const output = `@tool
class_name GodotMcpProtocolConstants
extends RefCounted

const PRODUCT_VERSION := ${JSON.stringify(product.productVersion)}
const BRIDGE_PROTOCOL_VERSION := ${JSON.stringify(product.bridgeProtocolVersion)}
`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) {
    process.stderr.write(`Generated protocol constants are stale: ${outputPath}\n`);
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output, "utf8");
  process.stdout.write(`Generated ${outputPath.slice(root.length)}\n`);
}
