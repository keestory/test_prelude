const spreadsheetIdPattern = /^[A-Za-z0-9_-]{20,100}$/;
const responseCache = new Map<string, { savedAt: number; value: unknown }>();
const maxSpreadsheetExportBytes = 20 * 1024 * 1024;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "apikey, authorization, content-type, x-client-info",
  vary: "origin",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isAuthorized(req: Request) {
  const configured = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
  const supplied = req.headers.get("apikey") || "";
  return Boolean(supplied && Object.values(configured).includes(supplied));
}

function decodeHtml(value: unknown) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

function normalizeHeader(value: unknown) {
  return decodeHtml(value).normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[\s_./·()-]+/g, "");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchText(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "PRELUDE-Sheet-Inspector/1.0" },
    });
    if (!response.ok) {
      const error = new Error(`Google 스프레드시트 응답 오류 (${response.status})`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function isAllowedGoogleExportUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (
      hostname === "docs.google.com"
      || hostname === "drive.google.com"
      || hostname === "drive.usercontent.google.com"
      || hostname.endsWith(".googleusercontent.com")
    );
  } catch {
    return false;
  }
}

async function fetchSpreadsheetExport(spreadsheetId: string) {
  const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(exportUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "PRELUDE-Sheet-Exporter/1.0" },
    });
    if (!response.ok) {
      const error = new Error(`Google 스프레드시트 Excel 내보내기 오류 (${response.status})`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    if (!isAllowedGoogleExportUrl(response.url)) {
      const error = new Error("허용되지 않은 주소로 연결되어 Excel 내보내기를 중단했습니다.") as Error & { status?: number };
      error.status = 502;
      throw error;
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxSpreadsheetExportBytes) {
      const error = new Error("Google 스프레드시트 Excel 파일은 20MB 이하만 사용할 수 있습니다.") as Error & { status?: number };
      error.status = 413;
      throw error;
    }
    const buffer = await response.arrayBuffer();
    const signature = new Uint8Array(buffer.slice(0, 4));
    if (buffer.byteLength > maxSpreadsheetExportBytes) {
      const error = new Error("Google 스프레드시트 Excel 파일은 20MB 이하만 사용할 수 있습니다.") as Error & { status?: number };
      error.status = 413;
      throw error;
    }
    if (signature.length < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
      const error = new Error("Google 스프레드시트가 Excel 파일로 내려오지 않았습니다. 공유 권한을 확인해 주세요.") as Error & { status?: number };
      error.status = 422;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/(spreadsheetml|octet-stream|zip)/i.test(contentType)) {
      const error = new Error("Google 스프레드시트가 올바른 Excel 형식으로 응답하지 않았습니다.") as Error & { status?: number };
      error.status = 422;
      throw error;
    }
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

type SpreadsheetTab = {
  sheetIndex: number;
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  hidden: boolean;
};

function parseSpreadsheetTabs(html: string): SpreadsheetTab[] {
  const entryPattern = /\[21350203,"((?:\\.|[^"\\])*)"\]/g;
  const tabs: SpreadsheetTab[] = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(html))) {
    let inner: string;
    let entry: unknown[];
    try {
      inner = JSON.parse(`"${match[1]}"`);
      entry = JSON.parse(inner);
    } catch {
      continue;
    }
    if (!Array.isArray(entry) || entry.length < 6 || typeof entry[0] !== "number" || !/^\d+$/.test(String(entry[2]))) continue;
    const titleMatch = JSON.stringify(entry).match(/\[0,0,"([^"]+)"\]/);
    if (!titleMatch) continue;
    tabs.push({
      sheetIndex: Number(entry[0]),
      sheetId: Number(entry[2]),
      title: titleMatch[1],
      rowCount: Number(entry.at(-2)) || 0,
      columnCount: Number(entry.at(-1)) || 0,
      hidden: false,
    });
  }
  return tabs.sort((left, right) => left.sheetIndex - right.sheetIndex);
}

function parseSheetRows(html: string, sheetId: number) {
  const rows: Array<{ row: number; cells: string[]; source: string }> = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html))) {
    const idMatch = rowMatch[1].match(new RegExp(`id=["']${sheetId}R(\\d+)["']`));
    if (!idMatch) continue;
    const cells: string[] = [];
    const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) cells.push(decodeHtml(cellMatch[2]));
    rows.push({ row: Number(idMatch[1]) + 1, cells, source: rowMatch[0] });
    if (rows.length >= 120) break;
  }
  return rows;
}

function findHeaderColumn(headers: string[], candidates: string[]) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  const index = headers.findIndex((header) => normalizedCandidates.includes(normalizeHeader(header)));
  return index < 0 ? null : index + 1;
}

async function analyzeSheetHtml(html: string, tab: SpreadsheetTab) {
  const rows = parseSheetRows(html, tab.sheetId);
  const productNameHeaders = ["제품명", "상품명", "상품명(KR)", "상품명(한글)", "상품명(영문)", "product name", "품명"];
  const quantityHeaders = ["발주수", "발주수량", "발주량", "발주개수", "주문수", "주문수량", "주문량", "주문개수", "수량", "개수", "qty", "quantity", "count", "order qty", "order quantity"];
  const headerRow = rows.find((row) => {
    const key = findHeaderColumn(row.cells, productNameHeaders);
    const qty = findHeaderColumn(row.cells, quantityHeaders);
    return key && qty;
  });
  const headers = headerRow ? headerRow.cells : [];
  const productNameColumn = findHeaderColumn(headers, productNameHeaders);
  const keyColumn = productNameColumn;
  const keyField = keyColumn ? "productName" : null;
  const qtyColumn = findHeaderColumn(headers, quantityHeaders);
  const optionColumn = findHeaderColumn(headers, ["옵션", "Option", "Option(Ko/En)", "색상규격"]);
  const sizeColumn = findHeaderColumn(headers, ["사이즈", "Size", "규격", "size(W x L x Hmm)"]);
  const barcodeColumn = findHeaderColumn(headers, ["바코드", "Barcode", "EAN13", "GTIN"]);
  const styleNoColumn = findHeaderColumn(headers, ["STYLE NO", "STYLE NO.", "STYLE NUMBER", "스타일NO", "스타일번호"]);
  const imageColumn = findHeaderColumn(headers, ["제품이미지", "상품이미지", "이미지", "product image", "image", "picture", "photo"]);
  const orderUnitColumn = findHeaderColumn(headers, ["주문단위", "입수", "포장단위"]);
  const retailPriceColumn = findHeaderColumn(headers, ["소비자가", "정가", "판매가", "RETAIL PRICE", "가격(RRP)", "RRP"]);
  const amountColumn = findHeaderColumn(headers, ["금액", "금 액", "합계금액"]);
  const dataRow = headerRow && keyColumn && rows.find((row) => row.row > headerRow.row && String(row.cells[keyColumn - 1] || "").trim() !== "");
  const dataStartRow = headerRow ? dataRow?.row || (tab.rowCount > headerRow.row ? headerRow.row + 1 : null) : null;
  const structureSignature = await sha256(JSON.stringify({
    headers: headers.map(normalizeHeader),
    headerRow: headerRow?.row || null,
    dataStartRow,
    keyColumn,
    qtyColumn,
  }));
  const formatSignature = await sha256(rows.slice(0, 40).map((row) => row.source.replace(/>([^<]*)</g, "><").replace(/\s+/g, " ")).join(""));
  const valid = Boolean(headerRow && keyColumn && qtyColumn && keyColumn !== qtyColumn);
  return {
    ...tab,
    headerRow: headerRow?.row || null,
    dataStartRow,
    headers,
    columns: { key: keyColumn, keyField, productName: productNameColumn, option: optionColumn, size: sizeColumn, barcode: barcodeColumn, styleNo: styleNoColumn, identityFields: ["productName", "option", "size", "barcode", "styleNo"].filter((field) => ({ productName: productNameColumn, option: optionColumn, size: sizeColumn, barcode: barcodeColumn, styleNo: styleNoColumn })[field as "productName" | "option" | "size" | "barcode" | "styleNo"]), image: imageColumn, retailPrice: retailPriceColumn, orderUnit: orderUnitColumn, qty: qtyColumn, amount: amountColumn },
    structureSignature,
    formatSignature,
    status: valid ? "CONFIRMED" : "NEEDS_REVIEW",
    issues: valid ? [] : [
      !keyColumn ? "상품명 열을 자동으로 확인하지 못했습니다." : null,
      !qtyColumn ? "발주수량 열을 자동으로 확인하지 못했습니다." : null,
      keyColumn && qtyColumn && keyColumn === qtyColumn ? "상품 식별 열과 발주수량 열은 서로 달라야 합니다." : null,
    ].filter(Boolean),
  };
}

function spreadsheetTitle(html: string) {
  const title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1]
    || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    || "Google 스프레드시트";
  return decodeHtml(title).replace(/\s+-\s+Google (Sheets|Drive).*$/i, "");
}

async function inspectPublicSpreadsheet(spreadsheetId: string) {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  const workbookHtml = await fetchText(`${base}?usp=sharing`);
  const tabs = parseSpreadsheetTabs(workbookHtml);
  if (!tabs.length) {
    const error = new Error("공개된 스프레드시트 탭을 읽지 못했습니다. 공유 권한을 확인해 주세요.") as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  const analyzedTabs = [];
  for (const tab of tabs) {
    const tabHtml = tab.sheetIndex === 0 ? workbookHtml : await fetchText(`${base}?gid=${tab.sheetId}#gid=${tab.sheetId}`);
    analyzedTabs.push(await analyzeSheetHtml(tabHtml, tab));
  }
  return {
    spreadsheetId,
    spreadsheetTitle: spreadsheetTitle(workbookHtml),
    checkedAt: new Date().toISOString(),
    sourceType: "PUBLIC_GOOGLE_SHEETS",
    workbookSignature: await sha256(analyzedTabs.map((tab) => `${tab.sheetId}:${tab.structureSignature}:${tab.formatSignature}`).join("|")),
    tabs: analyzedTabs,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST 요청만 지원합니다." });
  if (!isAuthorized(req)) return json(401, { error: "올바른 Supabase publishable key가 필요합니다." });

  const pathname = new URL(req.url).pathname;
  let payload: { spreadsheetId?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "올바른 JSON 요청이 아닙니다." });
  }
  const spreadsheetId = String(payload.spreadsheetId || "");
  if (!spreadsheetIdPattern.test(spreadsheetId)) return json(400, { error: "올바른 Google 스프레드시트 ID가 아닙니다." });

  try {
    if (pathname.endsWith("/inspect")) {
      const cached = responseCache.get(spreadsheetId);
      if (cached && Date.now() - cached.savedAt < 5_000) return json(200, cached.value);
      const value = await inspectPublicSpreadsheet(spreadsheetId);
      if (responseCache.size >= 100) responseCache.delete(responseCache.keys().next().value!);
      responseCache.set(spreadsheetId, { savedAt: Date.now(), value });
      return json(200, value);
    }
    if (pathname.endsWith("/export")) {
      const buffer = await fetchSpreadsheetExport(spreadsheetId);
      return new Response(buffer, {
        status: 200,
        headers: {
          ...corsHeaders,
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-length": String(buffer.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return json(404, { error: "지원하지 않는 경로입니다." });
  } catch (caught) {
    const error = caught as Error & { status?: number };
    const status = Number(error.status) || (error.name === "AbortError" ? 504 : 502);
    return json(status, { error: error.message || "Google 스프레드시트 요청을 처리하지 못했습니다." });
  }
});
