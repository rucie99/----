import { countExecutionRows, groupExecutionLines } from "./calculations.mjs";
import { SNAPSHOT_STATUS } from "./constants.mjs";

const XLSX_NAMESPACE = Object.freeze({
  MAIN: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  RELATIONSHIPS: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
});

const XLSX_FILE = Object.freeze({
  CONTENT_TYPES: "[Content_Types].xml",
  ROOT_RELS: "_rels/.rels",
  APP_PROPERTIES: "docProps/app.xml",
  CORE_PROPERTIES: "docProps/core.xml",
  WORKBOOK: "xl/workbook.xml",
  WORKBOOK_RELS: "xl/_rels/workbook.xml.rels",
  STYLES: "xl/styles.xml",
  WORKSHEET: "xl/worksheets/sheet1.xml",
});

const REPORT = Object.freeze({
  SHEET_NAME: "기성집행서",
  TABLE_HEADER_ROW: 9,
  FIRST_DATA_ROW: 10,
  COLUMN_COUNT: 9,
});

/** 금액 수식이 참조하는 열. */
const COLUMN = Object.freeze({
  BUDGET: "E",
  PURCHASE: "F",
});

const CELL_STYLE = Object.freeze({
  DEFAULT: 0,
  TITLE: 1,
  META: 2,
  SUMMARY_LABEL: 3,
  SUMMARY_AMOUNT: 4,
  SUMMARY_PERCENT: 5,
  TABLE_HEADER: 6,
  MAJOR: 7,
  TEXT: 8,
  ITEM_COUNT: 9,
  AMOUNT: 10,
  PERCENT: 11,
  SUBTOTAL_TEXT: 12,
  SUBTOTAL_AMOUNT: 13,
  SUBTOTAL_PERCENT: 14,
  TOTAL_TEXT: 15,
  TOTAL_AMOUNT: 16,
  TOTAL_PERCENT: 17,
  NOTE: 18,
  SIGN_LABEL: 19,
  SIGN_BOX: 20,
  MIDDLE: 21,
  MIDDLE_SUBTOTAL_TEXT: 22,
  MIDDLE_SUBTOTAL_AMOUNT: 23,
  MIDDLE_SUBTOTAL_PERCENT: 24,
});

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index) {
  let value = index;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cell(reference, value, style = CELL_STYLE.DEFAULT, formula = "") {
  const styleAttribute = style ? ` s="${style}"` : "";
  if (formula) {
    const cachedValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `<c r="${reference}"${styleAttribute}><f>${xmlEscape(formula)}</f><v>${cachedValue}</v></c>`;
  }
  if (typeof value === "number") return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  if (value === null || value === undefined || value === "") return `<c r="${reference}"${styleAttribute}/>`;
  return `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function row(rowNumber, values, options = {}) {
  const attributes = [
    `r="${rowNumber}"`,
    options.height ? `ht="${options.height}" customHeight="1"` : "",
  ].filter(Boolean).join(" ");
  const cells = values.map((value, index) => cell(
    `${columnName(index + 1)}${rowNumber}`,
    value.value,
    value.style,
    value.formula,
  )).join("");
  return `<row ${attributes}>${cells}</row>`;
}

function value(value, style, formula = "") {
  return { value, style, formula };
}

function emptyRow(style = CELL_STYLE.DEFAULT) {
  return Array.from({ length: REPORT.COLUMN_COUNT }, () => value("", style));
}

function itemCountText(items = []) {
  return items.length === 0 ? "미설정" : `${items.length.toLocaleString("ko-KR")}개 품번`;
}

function statusText(status) {
  return status === SNAPSHOT_STATUS.CONFIRMED ? "확정" : "작성중";
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** 행 번호 목록을 SUM 인수로 줄입니다. [10,11,12,14] → "E10:E12,E14" */
function sumArguments(column, rowNumbers) {
  const ranges = [];
  for (const rowNumber of rowNumbers) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === rowNumber - 1) last.end = rowNumber;
    else ranges.push({ start: rowNumber, end: rowNumber });
  }
  return ranges.map(({ start, end }) => (start === end ? `${column}${start}` : `${column}${start}:${column}${end}`)).join(",");
}

/** 실행예산 · 매입금액 · 잔액 · 집행률 네 칸. 잔액과 집행률은 같은 행의 E · F 를 참조합니다. */
function amountValues(rowNumber, totals, styles, formulas = {}) {
  return [
    value(totals.executionBudget, styles.amount, formulas.budget || ""),
    value(totals.purchaseAmount, styles.amount, formulas.purchase || ""),
    value(totals.balanceAmount, styles.amount, `${COLUMN.BUDGET}${rowNumber}-${COLUMN.PURCHASE}${rowNumber}`),
    value(totals.executionRate / 100, styles.percent,
      `IF(${COLUMN.BUDGET}${rowNumber}=0,0,${COLUMN.PURCHASE}${rowNumber}/${COLUMN.BUDGET}${rowNumber})`),
  ];
}

function buildWorksheet(snapshot, generatedAt) {
  const groups = groupExecutionLines(snapshot.lines);
  const grandRow = REPORT.FIRST_DATA_ROW + countExecutionRows(groups);
  const noteRow = grandRow + 2;
  const signLabelRow = grandRow + 4;
  const signBoxRow = grandRow + 5;
  const sheetRows = [];
  const merges = ["A1:I2", "A3:D3", "E3:I3", "A5:B5", "C5:D5", "E5:F5", "H5:I5", "A6:B6", "C6:D6", "E6:F6", "H6:I6", "A8:I8"];

  sheetRows.push(row(1, [value("기 성 집 행 서", CELL_STYLE.TITLE)], { height: 26 }));
  sheetRows.push(row(2, emptyRow(), { height: 12 }));
  sheetRows.push(row(3, [
    value(`프로젝트  ${snapshot.projectCode} · ${snapshot.projectName}`, CELL_STYLE.META),
    ...emptyRow().slice(1, 4),
    value(`버전  v${snapshot.versionNo} · ${statusText(snapshot.status)} · 저장 ${formatDateTime(snapshot.updatedAt)}`, CELL_STYLE.META),
  ], { height: 22 }));
  sheetRows.push(row(4, emptyRow(), { height: 8 }));
  sheetRows.push(row(5, [
    value("계약금액", CELL_STYLE.SUMMARY_LABEL), value("", CELL_STYLE.SUMMARY_LABEL),
    value("실행예산", CELL_STYLE.SUMMARY_LABEL), value("", CELL_STYLE.SUMMARY_LABEL),
    value("매입금액", CELL_STYLE.SUMMARY_LABEL), value("", CELL_STYLE.SUMMARY_LABEL),
    value("예상 이익", CELL_STYLE.SUMMARY_LABEL), value("예상 이익률", CELL_STYLE.SUMMARY_LABEL), value("", CELL_STYLE.SUMMARY_LABEL),
  ], { height: 21 }));
  sheetRows.push(row(6, [
    value(snapshot.totals.contractAmount, CELL_STYLE.SUMMARY_AMOUNT), value("", CELL_STYLE.SUMMARY_AMOUNT),
    value(snapshot.totals.executionBudget, CELL_STYLE.SUMMARY_AMOUNT, `${COLUMN.BUDGET}${grandRow}`), value("", CELL_STYLE.SUMMARY_AMOUNT),
    value(snapshot.totals.purchaseAmount, CELL_STYLE.SUMMARY_AMOUNT, `${COLUMN.PURCHASE}${grandRow}`), value("", CELL_STYLE.SUMMARY_AMOUNT),
    value(snapshot.totals.profitAmount, CELL_STYLE.SUMMARY_AMOUNT),
    value(snapshot.totals.profitRate / 100, CELL_STYLE.SUMMARY_PERCENT), value("", CELL_STYLE.SUMMARY_PERCENT),
  ], { height: 25 }));
  sheetRows.push(row(7, emptyRow(), { height: 8 }));
  sheetRows.push(row(8, [value("분류별 집행 현황", CELL_STYLE.META)], { height: 20 }));
  sheetRows.push(row(REPORT.TABLE_HEADER_ROW, [
    value("대분류", CELL_STYLE.TABLE_HEADER),
    value("중분류", CELL_STYLE.TABLE_HEADER),
    value("소분류", CELL_STYLE.TABLE_HEADER),
    value("연결 품번", CELL_STYLE.TABLE_HEADER),
    value("실행예산", CELL_STYLE.TABLE_HEADER),
    value("매입금액 소계", CELL_STYLE.TABLE_HEADER),
    value("예산잔액", CELL_STYLE.TABLE_HEADER),
    value("집행률", CELL_STYLE.TABLE_HEADER),
    value("비고", CELL_STYLE.TABLE_HEADER),
  ], { height: 24 }));

  const lineStyles = { amount: CELL_STYLE.AMOUNT, percent: CELL_STYLE.PERCENT };
  const middleSubtotalStyles = { amount: CELL_STYLE.MIDDLE_SUBTOTAL_AMOUNT, percent: CELL_STYLE.MIDDLE_SUBTOTAL_PERCENT };
  const majorTotalStyles = { amount: CELL_STYLE.SUBTOTAL_AMOUNT, percent: CELL_STYLE.SUBTOTAL_PERCENT };
  let currentRow = REPORT.FIRST_DATA_ROW;
  const majorTotalRows = [];
  for (const group of groups) {
    const groupStartRow = currentRow;
    // 대분류 합계는 라인 행만 더합니다. 중분류 소계 행까지 범위에 넣으면 이중으로 집계됩니다.
    const groupLineRows = [];
    let isFirstMajorRow = true;
    for (const middle of group.middles) {
      const middleStartRow = currentRow;
      for (const line of middle.lines) {
        sheetRows.push(row(currentRow, [
          value(isFirstMajorRow ? group.majorName : "", CELL_STYLE.MAJOR),
          value(currentRow === middleStartRow ? line.middleName : "", middle.hasMinors ? CELL_STYLE.MIDDLE : CELL_STYLE.TEXT),
          value(line.minorName || "", CELL_STYLE.TEXT),
          value(itemCountText(line.items), CELL_STYLE.ITEM_COUNT),
          ...amountValues(currentRow, line, lineStyles),
          value(line.remark || "", CELL_STYLE.TEXT),
        ], { height: 22 }));
        // 소분류가 없는 중분류는 중분류 · 소분류 칸을 합칩니다.
        if (!middle.hasMinors) merges.push(`B${currentRow}:C${currentRow}`);
        groupLineRows.push(currentRow);
        isFirstMajorRow = false;
        currentRow += 1;
      }
      const middleLineEndRow = currentRow - 1;
      if (middle.showSubtotal) {
        sheetRows.push(row(currentRow, [
          value("", CELL_STYLE.MAJOR),
          value("", CELL_STYLE.MIDDLE),
          value("소 계", CELL_STYLE.MIDDLE_SUBTOTAL_TEXT),
          value("", CELL_STYLE.MIDDLE_SUBTOTAL_TEXT),
          ...amountValues(currentRow, middle.totals, middleSubtotalStyles, {
            budget: `SUM(${COLUMN.BUDGET}${middleStartRow}:${COLUMN.BUDGET}${middleLineEndRow})`,
            purchase: `SUM(${COLUMN.PURCHASE}${middleStartRow}:${COLUMN.PURCHASE}${middleLineEndRow})`,
          }),
          value("", CELL_STYLE.MIDDLE_SUBTOTAL_TEXT),
        ], { height: 22 }));
        currentRow += 1;
      }
      if (middle.hasMinors && currentRow - 1 > middleStartRow) merges.push(`B${middleStartRow}:B${currentRow - 1}`);
    }
    const groupEndRow = currentRow - 1;
    if (groupEndRow > groupStartRow) merges.push(`A${groupStartRow}:A${groupEndRow}`);

    const totalRow = currentRow;
    majorTotalRows.push(totalRow);
    merges.push(`A${totalRow}:D${totalRow}`);
    sheetRows.push(row(totalRow, [
      value(`${group.majorName} 합계 · 중분류 ${group.middles.length.toLocaleString("ko-KR")}개`, CELL_STYLE.SUBTOTAL_TEXT),
      value("", CELL_STYLE.SUBTOTAL_TEXT),
      value("", CELL_STYLE.SUBTOTAL_TEXT),
      value("", CELL_STYLE.SUBTOTAL_TEXT),
      ...amountValues(totalRow, group.totals, majorTotalStyles, {
        budget: `SUM(${sumArguments(COLUMN.BUDGET, groupLineRows)})`,
        purchase: `SUM(${sumArguments(COLUMN.PURCHASE, groupLineRows)})`,
      }),
      value("", CELL_STYLE.SUBTOTAL_TEXT),
    ], { height: 23 }));
    currentRow += 1;
  }

  const totalFormula = (column) => majorTotalRows.length ? majorTotalRows.map((rowNumber) => `${column}${rowNumber}`).join("+") : "0";
  merges.push(`A${grandRow}:D${grandRow}`);
  sheetRows.push(row(grandRow, [
    value("전체 합계", CELL_STYLE.TOTAL_TEXT),
    value("", CELL_STYLE.TOTAL_TEXT),
    value("", CELL_STYLE.TOTAL_TEXT),
    value("", CELL_STYLE.TOTAL_TEXT),
    ...amountValues(grandRow, {
      executionBudget: snapshot.totals.executionBudget,
      purchaseAmount: snapshot.totals.purchaseAmount,
      balanceAmount: snapshot.totals.budgetBalance,
      executionRate: snapshot.totals.executionBudget === 0 ? 0 : (snapshot.totals.purchaseAmount / snapshot.totals.executionBudget) * 100,
    }, { amount: CELL_STYLE.TOTAL_AMOUNT, percent: CELL_STYLE.TOTAL_PERCENT }, {
      budget: totalFormula(COLUMN.BUDGET),
      purchase: totalFormula(COLUMN.PURCHASE),
    }),
    value("", CELL_STYLE.TOTAL_TEXT),
  ], { height: 25 }));

  merges.push(`A${noteRow}:I${noteRow}`, `A${signLabelRow}:E${signBoxRow}`);
  const confirmedNote = snapshot.confirmedBy
    ? ` · 확정 ${snapshot.confirmedBy} (${formatDateTime(snapshot.confirmedAt)})`
    : "";
  sheetRows.push(row(noteRow, [value(`기준: 저장된 스냅샷 v${snapshot.versionNo} · 생성 ${formatDateTime(generatedAt)} · 연결 품번은 건수만 표기${confirmedNote}`, CELL_STYLE.NOTE)], { height: 20 }));
  sheetRows.push(row(signLabelRow, [
    value("본 보고서는 아마란스10 입고 공급가액을 기준으로 작성되었습니다.", CELL_STYLE.NOTE),
    value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE),
    value("작성", CELL_STYLE.SIGN_LABEL), value("검토", CELL_STYLE.SIGN_LABEL), value("승인", CELL_STYLE.SIGN_LABEL), value("", CELL_STYLE.SIGN_LABEL),
  ], { height: 20 }));
  sheetRows.push(row(signBoxRow, [
    value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE), value("", CELL_STYLE.NOTE),
    value("", CELL_STYLE.SIGN_BOX), value("", CELL_STYLE.SIGN_BOX), value("", CELL_STYLE.SIGN_BOX), value("", CELL_STYLE.SIGN_BOX),
  ], { height: 38 }));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${XLSX_NAMESPACE.MAIN}" xmlns:r="${XLSX_NAMESPACE.RELATIONSHIPS}">
  <dimension ref="A1:I${signBoxRow}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="9" topLeftCell="A10" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>
    <col min="1" max="1" width="12" customWidth="1"/>
    <col min="2" max="2" width="17" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="11" customWidth="1"/>
    <col min="5" max="7" width="16" customWidth="1"/>
    <col min="8" max="8" width="10" customWidth="1"/>
    <col min="9" max="9" width="22" customWidth="1"/>
  </cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  <mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.35" right="0.35" top="0.4" bottom="0.45" header="0.2" footer="0.2"/>
  <pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
  <headerFooter><oddFooter>&amp;C&amp;9페이지 &amp;P / &amp;N</oddFooter></headerFooter>
</worksheet>`;
}

function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${XLSX_NAMESPACE.MAIN}">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="#,##0&quot;원&quot;;[Red](#,##0&quot;원&quot;);-"/>
    <numFmt numFmtId="165" formatCode="0.0%"/>
  </numFmts>
  <fonts count="5">
    <font><sz val="10"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
    <font><b/><sz val="20"/><color rgb="FF102042"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
    <font><b/><sz val="10"/><color rgb="FF172033"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
    <font><sz val="9"/><color rgb="FF64748B"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF102042"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F4"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="5">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFD8E0EA"/></bottom><diagonal/></border>
    <border><left style="thin"><color rgb="FFD8E0EA"/></left><right style="thin"><color rgb="FFD8E0EA"/></right><top style="thin"><color rgb="FFD8E0EA"/></top><bottom style="thin"><color rgb="FFD8E0EA"/></bottom><diagonal/></border>
    <border><left style="thin"><color rgb="FFB8C4D6"/></left><right style="thin"><color rgb="FFB8C4D6"/></right><top style="medium"><color rgb="FF7890B0"/></top><bottom style="thin"><color rgb="FFB8C4D6"/></bottom><diagonal/></border>
    <border><left/><right/><top style="medium"><color rgb="FF102042"/></top><bottom style="double"><color rgb="FF102042"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="25">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="3" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="164" fontId="3" fillId="5" borderId="3" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="5" borderId="3" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="4" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="164" fontId="2" fillId="2" borderId="4" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="2" borderId="4" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="3" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function buildWorkbook(lastRow) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${XLSX_NAMESPACE.MAIN}" xmlns:r="${XLSX_NAMESPACE.RELATIONSHIPS}">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
  <sheets><sheet name="${REPORT.SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets>
  <definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'${REPORT.SHEET_NAME}'!$A$1:$I$${lastRow}</definedName></definedNames>
  <calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
}

function buildPackageFiles(snapshot, generatedAt) {
  const lastRow = REPORT.FIRST_DATA_ROW + countExecutionRows(groupExecutionLines(snapshot.lines)) + 5;
  const createdAt = generatedAt.toISOString();
  return {
    [XLSX_FILE.CONTENT_TYPES]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    [XLSX_FILE.ROOT_RELS]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    [XLSX_FILE.APP_PROPERTIES]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>경기산업 기성집행서</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>워크시트</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${REPORT.SHEET_NAME}</vt:lpstr></vt:vector></TitlesOfParts><Company>경기산업</Company><AppVersion>1.0</AppVersion></Properties>`,
    [XLSX_FILE.CORE_PROPERTIES]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${REPORT.SHEET_NAME}</dc:title><dc:creator>경기산업 기성집행서</dc:creator><cp:lastModifiedBy>경기산업 기성집행서</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified></cp:coreProperties>`,
    [XLSX_FILE.WORKBOOK]: buildWorkbook(lastRow),
    [XLSX_FILE.WORKBOOK_RELS]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    [XLSX_FILE.STYLES]: buildStyles(),
    [XLSX_FILE.WORKSHEET]: buildWorksheet(snapshot, generatedAt),
  };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildZip(files, modifiedAt) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime(modifiedAt);

  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.from(content, "utf8");
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(stamp.time, 10);
    localHeader.writeUInt16LE(stamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(stamp.time, 12);
    centralHeader.writeUInt16LE(stamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  const entryCount = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function createSnapshotWorkbook(snapshot, options = {}) {
  const generatedAt = options.generatedAt ? new Date(options.generatedAt) : new Date();
  return buildZip(buildPackageFiles(snapshot, generatedAt), generatedAt);
}
