import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loginAsAdmin, startTestServer } from "./helpers/server.mjs";

const PUBLIC_DIR = resolve(import.meta.dirname, "..", "public");

test("사용 설명서는 로그인 전에도 열리고, 쓰는 그림과 스타일이 모두 내려온다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const page = await server.client.request("/manual.html");
  assert.equal(page.status, 200);
  const html = await page.response.text();
  assert.match(html, /기성집행서 사용 설명서/);

  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/(?:manual\/|manual\.css)[^"]*)"/g)].map((match) => match[1]))];
  assert.ok(assets.some((path) => path.endsWith(".webp")), "예시 화면이 있어야 합니다");
  for (const path of assets) {
    const asset = await server.client.request(path);
    assert.equal(asset.status, 200, `${path} 를 내려주지 못했습니다`);
    if (path.endsWith(".webp")) assert.equal(asset.response.headers.get("content-type"), "image/webp");
  }
});

test("설명서 그림 위의 번호마다 위치가 정해져 있다", () => {
  const html = readFileSync(join(PUBLIC_DIR, "manual.html"), "utf8");
  const shots = readFileSync(join(PUBLIC_DIR, "manual", "shots.css"), "utf8");
  for (const figure of html.matchAll(/<figure class="shot[^"]*" data-shot="([^"]+)">([\s\S]*?)<\/figure>/g)) {
    const [, name, body] = figure;
    for (const [, number] of body.matchAll(/class="mark mark-(\d+)"/g)) {
      assert.match(shots, new RegExp(`data-shot="${name}"\\] \\.mark-${number} \\{`), `${name} 의 ${number}번 위치가 없습니다`);
    }
  }
});

test("프로그램 오른쪽 위와 로그인 화면에서 설명서를 새 탭으로 연다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());

  const login = await (await server.client.request("/login")).response.text();
  assert.match(login, /href="\/manual\.html" target="_blank"/);

  await loginAsAdmin(server);
  const home = await (await server.client.request("/")).response.text();
  assert.match(home, /id="helpButton" href="\/manual\.html" target="_blank" rel="noopener"/);
});
