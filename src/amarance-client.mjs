import { createHmac, randomBytes } from "node:crypto";

import {
  AMARANCE_API_PATH,
  AMARANCE_AUTH_HEADER,
  AMARANCE_MODE,
  MAX_RECEIPT_HEADERS,
  PROJECT_STATUS,
} from "./constants.mjs";
import { badRequest, AppError } from "./errors.mjs";
import { toWon } from "./calculations.mjs";

const DEMO_ITEMS = [
  ["MAT-1001", "제어반 본체"],
  ["MAT-1002", "인버터"],
  ["PIPE-2001", "스테인리스 배관"],
  ["ELEC-3001", "전력 케이블"],
  ["PROC-4001", "프레임 가공"],
  ["ASSY-5001", "장비 조립"],
  ["SITE-6001", "현장 설치"],
  ["TEST-7001", "시운전"],
  ["SHIP-8001", "포장 및 운송"],
  ["PM-9001", "프로젝트 관리"],
];

const REQUEST_TIMEOUT_MS = 30_000;
const DETAIL_CONCURRENCY = 5;
/** 품목 전체 목록을 다시 받아오기 전까지 재사용하는 시간. */
const ITEM_CACHE_TTL_MS = 5 * 60_000;

/** 비교용 문자열: 대소문자 · 공백 · 하이픈 · 밑줄 차이를 무시합니다. */
function normalizeSearchText(value) {
  return String(value ?? "").toLowerCase().replace(/[\s\-_]/g, "");
}

/**
 * 품목 목록에서 검색어에 맞는 것을 골라 가까운 순으로 정렬합니다.
 * 띄어쓴 단어는 모두 들어 있어야 하고(AND), 각 단어는 품번 · 품명 · 규격 어디에 있어도 됩니다.
 * 순서: 품번 일치 → 품번으로 시작 → 품번에 포함 → 품명 · 규격에 포함.
 */
export function filterItems(items, query = "") {
  const terms = String(query).trim().split(/\s+/).map(normalizeSearchText).filter(Boolean);
  const whole = normalizeSearchText(query);
  const rank = (item) => {
    const code = normalizeSearchText(item.itemCode);
    if (!whole) return 0;
    if (code === whole) return 0;
    if (code.startsWith(whole)) return 1;
    if (code.includes(whole)) return 2;
    return 3;
  };
  return items
    .filter((item) => {
      const haystack = [item.itemCode, item.itemName, item.specification].map(normalizeSearchText).join("\u0000");
      return terms.every((term) => haystack.includes(term));
    })
    .map((item) => ({ item, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || String(a.item.itemCode).localeCompare(String(b.item.itemCode)))
    .map(({ item }) => item);
}

function mapProjectStatus(value) {
  if (String(value) === "0") return PROJECT_STATUS.COMPLETE;
  if (String(value) === "9") return PROJECT_STATUS.UNUSED;
  return PROJECT_STATUS.ACTIVE;
}

function toItem(item) {
  return {
    itemCode: String(item.itemCd ?? ""),
    itemName: String(item.itemNm ?? ""),
    specification: String(item.itemDc ?? ""),
  };
}

function compactDate(value) {
  return String(value ?? "").replaceAll("-", "");
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function configurationValue(configuration, propertyName, environmentName, fallback = "") {
  return configuration[propertyName] ?? configuration[environmentName] ?? fallback;
}

/** YYYY-MM-DD 또는 YYYYMMDD 를 받아 Date 로 바꿉니다. 형식이 틀리면 오류를 던집니다. */
function parseIsoDate(value, fieldName) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!match) throw badRequest(`${fieldName}을(를) YYYY-MM-DD 형식으로 입력해 주세요.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() + 1 !== Number(match[2])) {
    throw badRequest(`${fieldName}이(가) 실제 날짜가 아닙니다.`);
  }
  return date;
}

/** 입고 조회 기간을 검증하고 정규화합니다. */
export function normalizeDateRange({ fromDate, toDate, maxRangeDays }) {
  const from = parseIsoDate(fromDate, "입고 시작일");
  const to = parseIsoDate(toDate, "입고 종료일");
  if (from > to) throw badRequest("입고 시작일이 종료일보다 늦습니다.");
  const days = Math.round((to - from) / 86_400_000) + 1;
  if (days > maxRangeDays) {
    throw badRequest(`입고 조회 기간은 최대 ${maxRangeDays.toLocaleString("ko-KR")}일까지입니다. 현재 ${days.toLocaleString("ko-KR")}일이 선택되었습니다.`);
  }
  return { from: compactDate(fromDate), to: compactDate(toDate), days };
}

export function createAmaranceAuthHeaders(configuration, path, now = Date.now()) {
  const transactionId = randomBytes(15).toString("hex");
  const timestamp = String(Math.floor(now / 1000));
  const signatureValue = `${configuration.accessToken}${transactionId}${timestamp}${path}`;
  const signature = createHmac("sha256", configuration.hashKey).update(signatureValue, "utf8").digest("base64");
  return {
    "Content-Type": "application/json",
    [AMARANCE_AUTH_HEADER.CALLER_NAME]: configuration.callerName,
    [AMARANCE_AUTH_HEADER.AUTHORIZATION]: `Bearer ${configuration.accessToken}`,
    [AMARANCE_AUTH_HEADER.TRANSACTION_ID]: transactionId,
    [AMARANCE_AUTH_HEADER.TIMESTAMP]: timestamp,
    [AMARANCE_AUTH_HEADER.GROUP_SEQ]: configuration.groupSeq,
    [AMARANCE_AUTH_HEADER.SIGNATURE]: signature,
  };
}

export class AmaranceClient {
  constructor(configuration = process.env, { logger } = {}) {
    this.logger = logger;
    this.configure(configuration);
  }

  configure(configuration) {
    const mode = String(configurationValue(configuration, "mode", "AMARANTH_MODE", AMARANCE_MODE.DEMO)).toUpperCase();
    if (!Object.values(AMARANCE_MODE).includes(mode)) throw badRequest("연동 모드는 DEMO 또는 LIVE만 사용할 수 있습니다.");
    const baseUrl = String(configurationValue(configuration, "baseUrl", "AMARANTH_BASE_URL")).trim().replace(/\/$/, "");
    if (baseUrl) {
      let parsedUrl;
      try {
        parsedUrl = new URL(baseUrl);
      } catch {
        throw badRequest("API 기본 주소 형식이 올바르지 않습니다.");
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw badRequest("API 기본 주소는 http 또는 https 주소여야 합니다.");
    }
    this.mode = mode;
    this.baseUrl = baseUrl;
    this.companyCode = String(configurationValue(configuration, "companyCode", "AMARANTH_COMPANY_CODE")).trim();
    this.callerName = String(configurationValue(configuration, "callerName", "AMARANTH_CALLER_NAME")).trim();
    this.accessToken = String(configurationValue(configuration, "accessToken", "AMARANTH_ACCESS_TOKEN", configuration.AMARANTH_AUTH_TOKEN || ""));
    this.hashKey = String(configurationValue(configuration, "hashKey", "AMARANTH_HASH_KEY"));
    this.groupSeq = String(configurationValue(configuration, "groupSeq", "AMARANTH_GROUP_SEQ")).trim();
    this.receiptDetailPath = AMARANCE_API_PATH.RECEIPT_DETAIL_SEARCH;
    // 연동 대상이 바뀌면 이전 회사의 품목 목록을 쓰지 않도록 비웁니다.
    this.itemCache = null;
    return this;
  }

  getConfiguration() {
    return {
      mode: this.mode,
      baseUrl: this.baseUrl,
      companyCode: this.companyCode,
      callerName: this.callerName,
      groupSeq: this.groupSeq,
      receiptDetailPath: this.receiptDetailPath,
      baseUrlConfigured: Boolean(this.baseUrl),
      accessTokenConfigured: Boolean(this.accessToken),
      hashKeyConfigured: Boolean(this.hashKey),
      receiptDetailConfigured: Boolean(this.receiptDetailPath),
    };
  }

  /** accessToken 과 hashKey 를 포함합니다. 서버 내부에서만 사용해야 합니다. */
  getStoredConfiguration() {
    return { ...this.getConfiguration(), accessToken: this.accessToken, hashKey: this.hashKey };
  }

  async searchProjects() {
    if (this.mode === AMARANCE_MODE.DEMO) {
      return [
        { code: "P-2026-003", name: "평택 자동화설비 구축", contractAmount: 580_000_000, status: PROJECT_STATUS.ACTIVE },
        { code: "P-2026-002", name: "화성 생산라인 개선", contractAmount: 350_000_000, status: PROJECT_STATUS.ACTIVE },
        { code: "P-2025-011", name: "안산 제어반 교체", contractAmount: 180_000_000, status: PROJECT_STATUS.COMPLETE },
      ];
    }
    const result = await this.post(AMARANCE_API_PATH.PROJECT_SEARCH, {
      outCoCd: this.companyCode,
      outPjtCd: "",
      outPjtNm: "",
      pjtTy: "1",
      useYn: "ALL",
    });
    return result.map((project) => ({
      code: project.pjtCd,
      name: project.pjtNm,
      contractAmount: toWon(project.ordAm),
      status: mapProjectStatus(project.progFg),
    }));
  }

  /**
   * 품번 · 품명 · 규격의 일부로 품목을 찾습니다. 맞는 품목을 모두 가까운 순으로 돌려줍니다.
   *
   * 아마란스10 품목 조회 API 는 품번 · 품명을 '정확히 일치'로만 찾고, 둘을 함께 보내면 AND 로 묶습니다.
   * 그래서 조건 없이 전체 품목을 받아 두고(ITEM_CACHE_TTL_MS 동안 재사용) 여기서 부분 일치로 거릅니다.
   * 전체 조회가 실패하면 품번 · 품명 정확히 일치 조회로 대신합니다.
   */
  async searchItems(query = "", { refresh = false } = {}) {
    try {
      return filterItems(await this.listItems({ refresh }), query);
    } catch (error) {
      const exact = String(query).trim();
      if (this.mode === AMARANCE_MODE.DEMO || !exact) throw error;
      this.logger?.warn("품목 전체 조회에 실패해 정확히 일치 조회로 대신합니다.", { error });
      const [byCode, byName] = await Promise.all([
        this.post(AMARANCE_API_PATH.ITEM_SEARCH, { coCd: this.companyCode, itemCd: exact, itemNm: "", useYn: "1" }),
        this.post(AMARANCE_API_PATH.ITEM_SEARCH, { coCd: this.companyCode, itemCd: "", itemNm: exact, useYn: "1" }),
      ]);
      const unique = new Map([...byCode, ...byName].map((item) => [String(item.itemCd), item]));
      return [...unique.values()].map(toItem);
    }
  }

  /** 사용 중인 품목 전체 목록. 잠시 메모리에 두고 재사용합니다. */
  async listItems({ refresh = false } = {}) {
    if (this.mode === AMARANCE_MODE.DEMO) {
      return DEMO_ITEMS.map(([itemCode, itemName]) => ({ itemCode, itemName, specification: "" }));
    }
    if (!refresh && this.itemCache && Date.now() - this.itemCache.loadedAt < ITEM_CACHE_TTL_MS) {
      return this.itemCache.items;
    }
    const result = await this.post(AMARANCE_API_PATH.ITEM_SEARCH, {
      coCd: this.companyCode,
      itemCd: "",
      itemNm: "",
      useYn: "1",
    });
    // 응답의 다른 항목(100여 개)은 쓰지 않으므로 세 가지만 남겨 메모리를 아낍니다.
    const items = result.map(toItem);
    this.itemCache = { loadedAt: Date.now(), items };
    this.logger?.info("아마란스10 품목 목록을 받았습니다.", { count: items.length });
    return items;
  }

  /**
   * 기간 내 입고 헤더를 조회하고, 각 입고번호의 디테일에서 해당 프로젝트 건만 골라냅니다.
   * 헤더 조회에도 프로젝트 코드를 함께 보내 서버 측에서 걸러 줄 수 있으면 걸러지도록 합니다.
   */
  async fetchReceipts({ projectCode, fromDate, toDate, onProgress }) {
    if (this.mode === AMARANCE_MODE.DEMO) {
      const amounts = [48_500_000, 18_200_000, 12_700_000, 9_850_000, 31_400_000, 17_600_000, 22_000_000, 8_900_000, 6_700_000, 13_500_000];
      onProgress?.({ stage: "detail", done: DEMO_ITEMS.length, total: DEMO_ITEMS.length });
      return DEMO_ITEMS.map(([itemCode, itemName], index) => ({
        sourceKey: `${projectCode}-DEMO-${index + 1}`,
        receiptNo: `RV${String(index + 1).padStart(6, "0")}`,
        itemCode,
        itemName,
        receiptDate: compactDate(toDate || new Date().toISOString().slice(0, 10)),
        amount: amounts[index],
        vatAmount: Math.round(amounts[index] * 0.1),
      }));
    }

    const headers = await this.post(AMARANCE_API_PATH.RECEIPT_HEADER_SEARCH, {
      coCd: this.companyCode,
      rcvDtFrom: compactDate(fromDate),
      rcvDtTo: compactDate(toDate),
      rcvNb: "",
      pjtCd: String(projectCode ?? ""),
    });
    if (headers.length > MAX_RECEIPT_HEADERS) {
      throw badRequest(`조회 기간의 입고 건수가 너무 많습니다(${headers.length.toLocaleString("ko-KR")}건). 기간을 좁혀서 다시 시도해 주세요.`);
    }
    this.logger?.info("아마란스10 입고 헤더를 조회했습니다.", { count: headers.length, projectCode });
    onProgress?.({ stage: "header", done: headers.length, total: headers.length });

    let completed = 0;
    const receiptGroups = await mapWithConcurrency(headers, DETAIL_CONCURRENCY, async (header) => {
      const details = await this.post(AMARANCE_API_PATH.RECEIPT_DETAIL_SEARCH, {
        coCd: this.companyCode,
        rcvNb: header.rcvNb,
      });
      completed += 1;
      onProgress?.({ stage: "detail", done: completed, total: headers.length });
      return details
        .filter((detail) => !projectCode || String(detail.pjtCd ?? "") === String(projectCode))
        .map((detail, index) => ({
          sourceKey: `${header.rcvNb}:${detail.rcvSq ?? detail.lineNo ?? index + 1}`,
          receiptNo: header.rcvNb,
          itemCode: String(detail.itemCd ?? ""),
          itemName: String(detail.itemNm ?? detail.itemCd ?? ""),
          receiptDate: String(header.rcvDt ?? detail.rcvDt ?? ""),
          amount: toWon(detail.rcvgAm),
          vatAmount: toWon(detail.rcvvAm),
        }));
    });
    return receiptGroups.flat();
  }

  async post(path, body) {
    const missing = [
      [this.baseUrl, "API 기본 주소"],
      [this.companyCode, "회사코드"],
      [this.callerName, "callerName"],
      [this.accessToken, "accessToken"],
      [this.hashKey, "hashKey"],
      [this.groupSeq, "그룹시퀀스"],
    ].filter(([value]) => !value).map(([, name]) => name);
    if (missing.length) throw badRequest(`아마란스10 연동 설정이 필요합니다: ${missing.join(", ")}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = createAmaranceAuthHeaders(this.getStoredConfiguration(), path);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AppError(`아마란스10 API 호출에 실패했습니다 (HTTP ${response.status}).`, 502, "AMARANCE_HTTP");
      }
      const payload = await response.json();
      if (Number(payload.resultCode) !== 0) {
        throw new AppError(payload.resultMsg || "아마란스10 API가 오류를 반환했습니다.", 502, "AMARANCE_RESULT");
      }
      return Array.isArray(payload.resultData) ? payload.resultData : [];
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new AppError("아마란스10 API 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.", 504, "AMARANCE_TIMEOUT");
      }
      if (error instanceof AppError) throw error;
      this.logger?.error("아마란스10 API 호출 중 오류가 발생했습니다.", { path, error });
      throw new AppError("아마란스10 서버에 연결하지 못했습니다. 네트워크와 API 기본 주소를 확인해 주세요.", 502, "AMARANCE_NETWORK");
    } finally {
      clearTimeout(timeout);
    }
  }
}
