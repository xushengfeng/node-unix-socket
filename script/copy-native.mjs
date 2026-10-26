import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "index.node");
const targetDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, join(targetDir, "index.node"));

console.log(`myde-unix-socket: ${source} -> ${join(targetDir, "index.node")}`);
