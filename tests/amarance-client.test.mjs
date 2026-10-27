import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { AmaranceClient, createAmaranceAuthHeaders, filterItems } from "../src/amarance-client.mjs";

test("아마란스10 인증 헤더와 wehago-sign을 생성한다", () => {
  const path = "/apiproxy/api16S15";
  const configuration = {
    callerName: "CALLER_TEST",
    accessToken: "ACCESS_TEST",
    hashKey: "HASH_TEST",
    groupSeq: "GROUP_TEST",
  };
  const headers = createAmaranceAuthHeaders(configuration, path, 1_638_158_273_000);
  const signatureSource = `${configuration.accessToken}${headers["transaction-id"]}${headers.timestamp}${path}`;
  const expectedSignature = createHmac("sha256", configuration.hashKey).update(signatureSource, "utf8").digest("base64");

  assert.equal(headers.callerName, configuration.callerName);
  assert.equal(headers.Authorization, `Bearer ${configuration.accessToken}`);
  assert.equal(headers.groupSeq, configuration.groupSeq);
  assert.equal(headers["transaction-id"].length, 30);
  assert.equal(headers.timestamp, "1638158273");
  assert.equal(headers["wehago-sign"], expectedSignature);
});

test("저장 설정으로 프로젝트 API를 호출할 때 인증 헤더를 전송한다", async () => {
  let receivedHeaders;
  const server = createServer((request, response) => {
    receivedHeaders = request.headers;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      resultCode: 0,
      resultData: [{ pjtCd: "P-001", pjtNm: "연동 테스트", ordAm: 1000, progFg: "1" }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const client = new AmaranceClient({
    mode: "LIVE",
    baseUrl: `http://127.0.0.1:${address.port}`,
    companyCode: "1000",
    callerName: "CALLER_TEST",
    accessToken: "ACCESS_TEST",
    hashKey: "HASH_TEST",
    groupSeq: "GROUP_TEST",
  });

  const projects = await client.searchProjects();
  server.close();
  await once(server, "close");

  assert.equal(projects[0].code, "P-001");
  assert.equal(receivedHeaders.callername, "CALLER_TEST");
  assert.equal(receivedHeaders.authorization, "Bearer ACCESS_TEST");
  assert.equal(receivedHeaders.groupseq, "GROUP_TEST");
  assert.equal(receivedHeaders["transaction-id"].length, 30);
  assert.ok(receivedHeaders["wehago-sign"]);
});

test("입고 헤더의 입고번호로 디테일을 조회하고 원화금액을 매핑한다", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/apiproxy/api20A02S00201") {
      response.end(JSON.stringify({ resultCode: 0, resultData: [{ rcvNb: "RV2301000002", rcvDt: "20260806" }] }));
    } else {
      response.end(JSON.stringify({
        resultCode: 0,
        resultData: [{
          rcvNb: "RV2301000002",
          rcvSq: 1,
          itemCd: "MBD-A520M-001",
          itemNm: "메인보드 A520M",
          pjtCd: "P-001",
          rcvgAm: 1_000_000,
          rcvvAm: 100_000,
          rcvhAm: 1_100_000,
        }],
      }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const client = new AmaranceClient({
    mode: "LIVE",
    baseUrl: `http://127.0.0.1:${address.port}`,
    companyCode: "5550",
    callerName: "CALLER_TEST",
    accessToken: "ACCESS_TEST",
    hashKey: "HASH_TEST",
    groupSeq: "GROUP_TEST",
  });

  const receipts = await client.fetchReceipts({ projectCode: "P-001", fromDate: "2026-08-01", toDate: "2026-08-06" });
  server.close();
  await once(server, "close");

  assert.equal(requests[0].path, "/apiproxy/api20A02S00201");
  assert.equal(requests[1].path, "/apiproxy/api20A02S00202");
  assert.equal(requests[1].body.rcvNb, "RV2301000002");
  assert.equal(receipts[0].sourceKey, "RV2301000002:1");
  assert.equal(receipts[0].itemCode, "MBD-A520M-001");
  assert.equal(receipts[0].amount, 1_000_000);
  assert.equal(receipts[0].vatAmount, 100_000);
});

test("품번 · 품명 · 규격의 일부로 찾고, 품번이 가까운 것부터 보여준다", () => {
  const items = [
    { itemCode: "BE-000001", itemName: "OILLESS BUSH", specification: "" },
    { itemCode: "A-A00001", itemName: "OILLESS BUSH", specification: "Φ20" },
    { itemCode: "ET-000001", itemName: "핸들손잡이", specification: "A-A00001 호환" },
    { itemCode: "A-A00010", itemName: "볼트", specification: "M8" },
  ];
  // 품번이 정확히 같은 것 → 품번이 그것으로 시작하는 것 → 규격에만 있는 것
  assert.deepEqual(filterItems(items, "A-A00001").map((item) => item.itemCode), ["A-A00001", "ET-000001"]);
  assert.deepEqual(filterItems(items, "a-a0").map((item) => item.itemCode), ["A-A00001", "A-A00010", "ET-000001"]);
  // 대소문자 · 하이픈 · 공백 차이는 무시합니다.
  assert.deepEqual(filterItems(items, "aa00001").map((item) => item.itemCode), ["A-A00001", "ET-000001"]);
  assert.equal(filterItems(items, "bush").length, 2);
  // 띄어 쓴 단어는 모두 들어 있어야 합니다.
  assert.deepEqual(filterItems(items, "bush Φ20").map((item) => item.itemCode), ["A-A00001"]);
  assert.equal(filterItems(items, "").length, 4);
  assert.equal(filterItems(items, "없는품번").length, 0);
});

test("LIVE 품번 검색은 전체 품목을 한 번 받아 부분 일치로 거르고, 잠시 재사용한다", async () => {
  const requests = [];
  let failFullList = false;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const all = [
      { itemCd: "A-A00001", itemNm: "OILLESS BUSH", itemDc: "Φ20" },
      { itemCd: "BE-000001", itemNm: "OILLESS BUSH", itemDc: "" },
    ];
    const full = !body.itemCd && !body.itemNm;
    // 실제 API 처럼 품번 · 품명은 정확히 일치, 둘 다 주면 AND 입니다.
    const rows = all.filter((row) => (!body.itemCd || row.itemCd === body.itemCd) && (!body.itemNm || row.itemNm === body.itemNm));
    response.writeHead(full && failFullList ? 500 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ resultCode: 0, resultData: rows }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new AmaranceClient({
    mode: "LIVE",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    companyCode: "1000",
    callerName: "CALLER_TEST",
    accessToken: "ACCESS_TEST",
    hashKey: "HASH_TEST",
    groupSeq: "GROUP_TEST",
  });

  try {
    const found = await client.searchItems("A-A0");
    assert.deepEqual(found, [{ itemCode: "A-A00001", itemName: "OILLESS BUSH", specification: "Φ20" }]);
    assert.deepEqual(requests[0], { coCd: "1000", itemCd: "", itemNm: "", useYn: "1" }, "조건 없이 전체를 받아야 합니다");

    // 두 번째 검색은 받아 둔 목록을 씁니다.
    assert.equal((await client.searchItems("bush")).length, 2);
    assert.equal(requests.length, 1);

    // 새로 받기를 요청하면 다시 조회합니다.
    await client.searchItems("bush", { refresh: true });
    assert.equal(requests.length, 2);

    // 전체 조회가 실패하면 품번 · 품명 정확히 일치로 대신 찾습니다.
    failFullList = true;
    const fallback = await client.searchItems("A-A00001", { refresh: true });
    assert.deepEqual(fallback.map((item) => item.itemCode), ["A-A00001"]);
    assert.ok(requests.some((body) => body.itemCd === "A-A00001" && body.itemNm === ""));
    assert.ok(requests.some((body) => body.itemCd === "" && body.itemNm === "A-A00001"));
  } finally {
    server.close();
    await once(server, "close");
  }
});
