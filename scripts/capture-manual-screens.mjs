/**
 * 사용 설명서(public/manual.html)에 넣을 예시 화면을 다시 찍습니다.
 *
 *   node scripts/capture-manual-screens.mjs
 *
 * 임시 DB 로 DEMO 서버를 띄워 예시 데이터(소분류 · 실행예산 · 입고 · 사용자)를 넣고,
 * 설치된 Edge(없으면 Chrome)를 헤드리스로 열어 화면 부분을 2배 해상도로 찍습니다.
 * 결과:
 *   public/manual/img/<이름>.webp  예시 화면
 *   public/manual/shots.css        화면 위 번호 표시(①②③)의 위치
 * 실제 고객 데이터는 쓰지 않으므로 화면이 바뀌면 언제든 다시 돌려도 됩니다.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loginAsAdmin, startTestServer } from "../tests/helpers/server.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(ROOT, "public", "manual");
const IMAGE_DIR = join(OUTPUT_DIR, "img");
const ADMIN_PASSWORD = "Manual!demo2026";
const BROWSER_CANDIDATES = [
  process.env.MANUAL_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------ 예시 데이터

async function seedDemo(server) {
  const call = async (path, options = {}) => {
    const result = await server.client.request(path, options);
    if (result.status >= 400) throw new Error(`${options.method || "GET"} ${path} 실패: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const bootstrap = await call("/api/bootstrap");
  const project = bootstrap.projects[0];
  const purchase = bootstrap.categories.find((major) => major.name === "자재비").middleCategories.find((middle) => middle.name === "구매품");
  for (const name of ["구입품비", "재고사용", "설계MISS(품확)"]) {
    await call("/api/minor-categories", { method: "POST", body: { middleCategoryId: purchase.id, name } });
  }

  const snapshot = await call(`/api/projects/${project.id}/snapshots`, { method: "POST", body: {} });
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const imported = await call(`/api/snapshots/${snapshot.id}/receipts/import`, { method: "POST", body: { fromDate, toDate } });

  // 전기자재는 예산을 넘긴 예(빨간 △)를 보여 주려고 일부러 낮게 잡습니다.
  const budgets = {
    구입품비: [80_000_000, ""], 재고사용: [5_000_000, ""], "설계MISS(품확)": [3_000_000, ""],
    배관자재: [15_000_000, ""], 전기자재: [9_000_000, "케이블 추가 발주"],
    가공비: [35_000_000, ""], "검사/조립": [20_000_000, ""],
    설치비: [25_000_000, ""], 시운전비: [10_000_000, ""], "포장/운반비": [8_000_000, ""],
    "PM 관리비": [15_000_000, "월 단위 정산"],
  };
  const current = imported.snapshot;
  const lines = current.lines
    .filter((line) => budgets[line.minorName || line.middleName])
    .map((line) => {
      const [executionBudget, remark] = budgets[line.minorName || line.middleName];
      return { id: line.id, executionBudget, remark };
    });
  await call(`/api/snapshots/${snapshot.id}/lines`, { method: "PUT", body: { lines, expectedRevision: current.revision } });

  // 품번 검색 화면에서 '연결' 할 수 있는 품목이 보이도록 하나를 풉니다(이미 만든 집행서는 그대로).
  const categories = await call("/api/categories");
  const testItem = categories.flatMap((major) => major.middleCategories)
    .flatMap((middle) => [...middle.items, ...middle.minorCategories.flatMap((minor) => minor.items)])
    .find((item) => item.itemCode === "TEST-7001");
  if (testItem) await call(`/api/item-mappings/${testItem.id}`, { method: "DELETE" });

  for (const user of [
    { loginId: "kim.writer", name: "김작성", role: "EDITOR" },
    { loginId: "lee.viewer", name: "이조회", role: "VIEWER" },
  ]) {
    await call("/api/users", { method: "POST", body: user });
  }
}

// ------------------------------------------------------------ 브라우저(CDP)

async function openBrowser() {
  const executable = BROWSER_CANDIDATES.find((path) => existsSync(path));
  if (!executable) throw new Error("Edge 또는 Chrome 을 찾을 수 없습니다. MANUAL_BROWSER 환경변수로 경로를 지정하세요.");
  const profile = mkdtempSync(join(tmpdir(), "gi-manual-browser-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--lang=ko-KR", "about:blank",
  ], { stdio: "ignore" });

  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    await sleep(200);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find((item) => item.type === "page");
    } catch { /* 아직 뜨는 중 */ }
  }
  if (!target) throw new Error("헤드리스 브라우저에 연결하지 못했습니다.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(message.error.message));
      else done(message.result);
    } else if (message.method && listeners.has(message.method)) {
      listeners.get(message.method)();
      listeners.delete(message.method);
    }
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    nextId += 1;
    pending.set(nextId, { done, fail });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
  const once = (method) => new Promise((done) => listeners.set(method, done));

  await send("Page.enable");
  return {
    send,
    async viewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    },
    async goto(url) {
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
      await sleep(600);
    },
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`스크립트 오류: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      return result.result.value;
    },
    async waitFor(expression, label) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await this.evaluate(expression)) return;
        await sleep(150);
      }
      throw new Error(`화면이 준비되지 않았습니다: ${label}`);
    },
    async close() {
      socket.close();
      child.kill();
      await sleep(400);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

// ------------------------------------------------------------ 찍기

const markerRules = [];

/**
 * selectors 를 모두 덮는 영역을 찍고, markers 의 각 요소 왼쪽 위 모서리에 번호를 둘 위치를 기록합니다.
 * maxBottom 을 주면 그 요소의 아래 끝에서 자릅니다(긴 표의 앞부분만).
 */
async function shoot(browser, name, { selectors, markers = [], padding = 12, maxBottom = null }) {
  const geometry = await browser.evaluate(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
    const pick = (selector) => { const el = document.querySelector(selector); if (!el) throw new Error('없는 요소: ' + selector); return el; };
    const areas = ${JSON.stringify(selectors)}.map((s) => box(pick(s)));
    let x0 = Math.min(...areas.map((a) => a.x)), y0 = Math.min(...areas.map((a) => a.y));
    let x1 = Math.max(...areas.map((a) => a.x + a.w)), y1 = Math.max(...areas.map((a) => a.y + a.h));
    ${maxBottom ? `const cut = box(pick(${JSON.stringify(maxBottom)})); y1 = Math.min(y1, cut.y + cut.h);` : ""}
    const marks = ${JSON.stringify(markers)}.map((s) => box(pick(s)));
    return { x0, y0, x1, y1, marks };
  })()`);
  const clip = {
    x: Math.max(0, geometry.x0 - padding),
    y: Math.max(0, geometry.y0 - padding),
    width: geometry.x1 - geometry.x0 + padding * 2,
    height: geometry.y1 - geometry.y0 + padding * 2,
    scale: 1,
  };
  const shot = await browser.send("Page.captureScreenshot", { format: "webp", quality: 90, clip, captureBeyondViewport: true });
  writeFileSync(join(IMAGE_DIR, `${name}.webp`), Buffer.from(shot.data, "base64"));
  // 그림이 늦게 떠도 자리가 미리 잡혀 목차로 이동할 때 위치가 어긋나지 않게 합니다.
  markerRules.push(`.shot[data-shot="${name}"] img { aspect-ratio: ${Math.round(clip.width)} / ${Math.round(clip.height)}; }`);

  geometry.marks.forEach((mark, index) => {
    const left = ((mark.x - clip.x) / clip.width) * 100;
    const top = ((mark.y - clip.y) / clip.height) * 100;
    markerRules.push(`.shot[data-shot="${name}"] .mark-${index + 1} { left: ${left.toFixed(2)}%; top: ${top.toFixed(2)}%; }`);
  });
  console.log(`  ${name}.webp  ${Math.round(clip.width)}×${Math.round(clip.height)} · 번호 ${geometry.marks.length}개`);
}

async function openScreen(browser, screen) {
  await browser.evaluate(`document.querySelector('.nav-item[data-screen="${screen}"]').click()`);
  await sleep(900);
}

async function main() {
  mkdirSync(IMAGE_DIR, { recursive: true });
  console.log("예시 데이터를 준비합니다...");
  const server = await startTestServer();
  let browser;
  try {
    await loginAsAdmin(server, ADMIN_PASSWORD);
    await seedDemo(server);

    console.log("화면을 찍습니다...");
    browser = await openBrowser();

    // 로그인
    await browser.viewport(1280, 900);
    await browser.goto(`${server.origin}/login`);
    await shoot(browser, "login", {
      selectors: [".login-card"],
      markers: ["#loginId", "#password", "#loginSubmit", ".login-help a"],
    });
    await browser.evaluate(`(() => {
      document.querySelector('#loginId').value = 'admin';
      document.querySelector('#password').value = ${JSON.stringify(ADMIN_PASSWORD)};
      document.querySelector('#loginForm').requestSubmit();
    })()`);
    await sleep(1200);
    if (!(await browser.evaluate("location.pathname === '/'"))) await browser.goto(`${server.origin}/`);
    await browser.waitFor("!document.querySelector('#snapshotContent').classList.contains('hidden') && document.querySelectorAll('.statement-line').length > 0", "집행서");

    // 전체 화면(보통 노트북 크기)
    await browser.viewport(1440, 900);
    await sleep(500);
    await shoot(browser, "overview", {
      selectors: [".app-shell"],
      maxBottom: ".import-panel",
      padding: 0,
      markers: [".sidebar .nav-item", ".project-toolbar", ".snapshot-bar", ".summary-grid", ".import-panel", "#helpButton"],
    });
    await shoot(browser, "topbar", { selectors: [".topbar-actions"], markers: ["#helpButton", "#userMenuButton"] });

    // 부분 화면은 세로로 넉넉한 창에서 찍습니다.
    await browser.viewport(1440, 2600);
    await sleep(500);
    await shoot(browser, "project-bar", {
      selectors: [".project-toolbar", ".snapshot-bar"],
      markers: ["#projectFilter", "#projectSelect", "#cloneSnapshotButton", "#newSnapshotButton", "#snapshotSelect", "#toggleSnapshotStatusButton"],
    });
    await shoot(browser, "summary", {
      selectors: [".summary-grid"],
      markers: [".summary-card.navy", ".summary-card.blue", ".summary-card.amber", ".summary-card.green"],
    });
    await shoot(browser, "import", {
      selectors: [".import-panel"],
      markers: ["#fromDate", "#toDate", "#replaceReceipts", "#importReceiptsButton"],
    });
    await shoot(browser, "table", {
      selectors: [".table-panel"],
      maxBottom: '[data-subtotal="0"]',
      markers: [".merged-middle-cell", ".statement-line .minor-cell", ".budget-input", ".middle-subtotal", '[data-subtotal="0"]', "#saveStatementButton", "#printStatementButton", "#exportExcelButton"],
    });
    await shoot(browser, "table-totals", {
      selectors: ['[data-subtotal="2"]', "#statementTotals"],
      padding: 0,
      markers: ['[data-subtotal="2"]', "#statementTotals"],
    });
    await browser.evaluate("document.querySelector('.receipt-details').open = true");
    await sleep(300);
    await shoot(browser, "receipts", {
      selectors: [".receipt-details"],
      maxBottom: "#receiptRows tr:nth-child(5)",
      markers: [".receipt-details summary", "#clearReceiptsButton", "#receiptRows tr:first-child .delete-receipt"],
    });

    // 분류 · 품번 설정 (네 칸이 한 줄에 보이는 넓은 창)
    await browser.viewport(1680, 1400);
    await openScreen(browser, "settings");
    await browser.waitFor("document.querySelectorAll('#minorList .master-row').length > 0", "소분류");
    await shoot(browser, "settings", {
      selectors: [".version-bar", ".settings-layout"],
      markers: ["#categorySetSelect", "#addMajorButton", "#addMiddleButton", "#addMinorButton", ".item-panel .panel-heading"],
    });
    await browser.evaluate(`(() => {
      document.querySelector('#itemSearchInput').value = 'test';
      document.querySelector('#itemSearchButton').click();
    })()`);
    await browser.waitFor("document.querySelectorAll('#itemSearchResults .search-result').length > 0", "품번 검색");
    await shoot(browser, "item-search", {
      selectors: [".item-panel .item-search-row", "#itemSearchResults"],
      markers: ["#itemSearchInput", "#itemSearchButton", "#itemSearchResults .search-result button", ".refresh-item-list"],
    });

    // 접속 · 보안
    await browser.viewport(1440, 2000);
    await openScreen(browser, "security");
    await browser.waitFor("Number(document.querySelector('#receiptMaxRangeDays').value) > 0", "보안 설정");
    // 찍을 패널에 이름이 없어 잠시 id 를 붙입니다(이 브라우저 안에서만).
    await browser.evaluate(`(() => {
      const panel = document.querySelector('#receiptMaxRangeDays').closest('.panel');
      panel.id = 'manualSecurityPanel';
      document.querySelector('#securitySettingsForm .integration-actions').id = 'manualSecurityActions';
    })()`);
    await shoot(browser, "security", {
      selectors: ["#manualSecurityPanel"],
      markers: ["#sessionIdleMinutes", "#receiptMaxRangeDays"],
    });
    await shoot(browser, "security-save", { selectors: ["#manualSecurityActions"], markers: ["#manualSecurityActions button"] });

    // 사용자
    await openScreen(browser, "users");
    await browser.waitFor("document.querySelectorAll('#userRows tr').length >= 3", "사용자");
    await browser.evaluate("document.querySelector('#userRows').closest('.panel').id = 'manualUsersPanel'");
    await shoot(browser, "users", {
      selectors: ["#manualUsersPanel"],
      markers: ["#addUserButton", "#userRows tr:nth-child(2) .role-select", "#userRows tr:nth-child(2) .toggle-user", "#userRows tr:nth-child(2) .reset-password"],
    });

    writeFileSync(join(OUTPUT_DIR, "shots.css"),
      "/* scripts/capture-manual-screens.mjs 가 만든 파일입니다. 직접 고치지 말고 스크립트를 다시 돌리세요. */\n"
      + `${markerRules.join("\n")}\n`);
    console.log(`완료: ${IMAGE_DIR}`);
  } finally {
    await browser?.close();
    await server.stop();
  }
}

await main();
