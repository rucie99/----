import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { AmaranceClient, createAmaranceAuthHeaders } from "../src/amarance-client.mjs";

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
