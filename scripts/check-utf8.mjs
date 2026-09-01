import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directories = ["src", "public", "tests", "scripts", "config"];
const rootFiles = [
  "README.md",
  "DEPLOYMENT.md",
  "install.ps1",
  "uninstall.ps1",
  "start-server.ps1",
  "stop-server.ps1",
  "run-server.cmd",
  "stop-server.cmd",
];
const extensions = new Set([".mjs", ".js", ".html", ".css", ".json", ".md", ".ps1", ".cmd"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const problems = [];
let checked = 0;

function inspectFile(path) {
  const bytes = readFileSync(path);
  const name = relative(root, path);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    problems.push(`UTF-8 로 읽을 수 없습니다: ${name}`);
    return;
  }
  // 대체 문자(U+FFFD)는 잘못된 인코딩 변환의 흔적입니다. 이 파일 자체가 걸리지 않도록 코드로 표기합니다.
  if (text.includes(String.fromCharCode(0xfffd))) problems.push(`대체 문자가 포함되어 있습니다: ${name}`);

  const extension = extname(path).toLowerCase();
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

  // Windows PowerShell 5.1 은 BOM 없는 UTF-8 스크립트의 한글을 깨뜨려 파싱 오류를 냅니다.
  if (extension === ".ps1" && !hasBom) {
    problems.push(`PowerShell 스크립트에는 UTF-8 BOM 이 필요합니다: ${name}`);
  }
  // cmd.exe 는 배치파일을 OEM 코드 페이지로 읽어 UTF-8 한글이 깨지고 파싱까지 망가집니다.
  if (extension === ".cmd") {
    if (hasBom) problems.push(`배치파일에는 BOM 을 넣지 않습니다: ${name}`);
    const offset = bytes.findIndex((byte) => byte > 0x7f);
    if (offset >= 0) {
      problems.push(`배치파일은 ASCII 문자만 사용해야 합니다(한글은 .ps1 로 옮기세요): ${name} (${offset}번째 바이트)`);
    }
  }
  checked += 1;
}

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (extensions.has(extname(entry.name).toLowerCase())) inspectFile(path);
  }
}

for (const directory of directories) inspect(join(root, directory));
for (const file of rootFiles) inspectFile(join(root, file));

if (problems.length) {
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`인코딩 검증 실패: ${problems.length}건`);
  process.exit(1);
}
console.log(`인코딩 검증 완료: ${checked}개 파일 (PowerShell BOM · 배치 ASCII 규칙 포함)`);
