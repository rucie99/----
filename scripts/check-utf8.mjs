import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directories = ["src", "public", "tests", "scripts", "config"];
const rootFiles = ["README.md", "DEPLOYMENT.md", "install.ps1", "uninstall.ps1", "run-server.cmd", "stop-server.cmd"];
const extensions = new Set([".mjs", ".js", ".html", ".css", ".json", ".md", ".ps1", ".cmd"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
let checked = 0;

function inspectFile(path) {
  const text = decoder.decode(readFileSync(path));
  if (text.includes(String.fromCharCode(0xfffd))) throw new Error(`대체 문자가 포함되어 있습니다: ${path}`);
  checked += 1;
}

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      inspect(path);
    } else if (extensions.has(extname(entry.name).toLowerCase())) {
      inspectFile(path);
    }
  }
}

for (const directory of directories) inspect(join(root, directory));
for (const file of rootFiles) inspectFile(join(root, file));
console.log(`UTF-8 검증 완료: ${checked}개 파일`);
