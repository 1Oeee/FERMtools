// En liten xlsx-skrivare utan beroenden.
//
// En xlsx-fil är en zip med några XML-filer i. Zip-delen packar inte (metod
// 0, "stored") — filerna blir större än Excels egna, men koden blir några
// rader i stället för en deflate-implementation, och en rapport på några
// tusen rader är fortfarande bara någon megabyte. Strängar skrivs inline i
// cellerna i stället för i en delad tabell, av samma skäl.
//
// Det som stöds är det rapporterna behöver: flera blad, fet rubrikrad, låst
// rubrikrad, autofilter, kolumnbredder, tal, datum och fetstil per cell.

// --- Zip ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Tid och datum i DOS-format, som zip vill ha dem. */
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: (Math.max(date.getFullYear() - 1980, 0) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * @param {Array<{ name: string, data: Uint8Array }>} files
 * @returns {Uint8Array}
 */
export function zip(files, when = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version som behövs
    local.setUint16(6, 0x0800, true); // namnen är UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), name, file.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- Kalkylbladet ---------------------------------------------------------

// Tecken XML 1.0 inte tillåter. Ett enhetsnamn med ett styrtecken i hade
// annars gjort hela filen oläsbar för Excel.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(text) {
  return String(text)
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Kolumnbokstäver: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** Excel räknar dagar sedan 1899-12-30. */
export const excelDate = (date) => date.getTime() / 86_400_000 + 25569;

// Stilarnas index i styles.xml nedan.
const STYLE = { plain: 0, bold: 1, date: 2, header: 3, title: 4, muted: 5, total: 6 };

/** En cell: ett värde, eller { value, bold } / { value, style: "header" | "title" | "muted" | "total" }. */
const unbox = (cell) =>
  cell !== null && typeof cell === "object" && !(cell instanceof Date)
    ? { value: cell.value, style: STYLE[cell.style] ?? (cell.bold ? STYLE.bold : 0) }
    : { value: cell, style: 0 };

function cellXml(value, ref, styleOrBold) {
  if (value === null || value === undefined || value === "") return "";
  const style = typeof styleOrBold === "number" ? styleOrBold : styleOrBold ? STYLE.bold : 0;
  const s = style ? ` s="${style}"` : "";

  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(value)}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/**
 * @typedef {{ header: string, width?: number }} Column
 * @typedef {string|number|boolean|Date|null|{ value: any, bold?: boolean }} Cell
 * @typedef {{ name: string, columns: Column[], rows: Cell[][], filter?: boolean }} Sheet
 */

/**
 * Ett fritt blad: rader och celler där de står, kolumnbredder, och ett
 * autofilter över det område man anger. För rapporter med mer än en tabell —
 * en lista med en sammanfattning bredvid.
 *
 * @param {{ grid: Cell[][], widths?: number[], autoFilter?: string, freezeRow?: number }} sheet
 *   freezeRow: raderna ovanför den (1-baserad) står kvar när man scrollar.
 */
function gridXml({ grid, widths = [], autoFilter = null, freezeRow = 0 }) {
  const cols = widths
    .map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : ""))
    .join("");
  const body = grid
    .map((row, r) => {
      const cells = (row ?? [])
        .map((cell, c) => {
          const { value, style } = unbox(cell);
          return cellXml(value, `${columnName(c)}${r + 1}`, style);
        })
        .join("");
      return cells ? `<row r="${r + 1}">${cells}</row>` : "";
    })
    .join("");
  const pane = freezeRow > 1
    ? `<pane ySplit="${freezeRow - 1}" topLeftCell="A${freezeRow}" activePane="bottomLeft" state="frozen"/>`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${body}</sheetData>` +
    (autoFilter ? `<autoFilter ref="${autoFilter}"/>` : "") +
    `</worksheet>`
  );
}

function sheetXml(sheet) {
  if (sheet.grid) return gridXml(sheet);
  return tableXml(sheet);
}

function tableXml({ columns, rows, filter = true }) {
  const lastCol = columnName(Math.max(columns.length - 1, 0));
  const lastRow = rows.length + 1;

  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`)
    .join("");

  const header = `<row r="1">${columns.map((c, i) => cellXml(c.header, `${columnName(i)}1`, true)).join("")}</row>`;
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const { value, style } = unbox(cell);
          return cellXml(value, `${columnName(c)}${r + 2}`, style);
        })
        .join("");
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${header}${body}</sheetData>` +
    (filter && columns.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : "") +
    `</worksheet>`
  );
}

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
  `<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="14"/><name val="Calibri"/></font>` +
  `<font><i/><sz val="10"/><color rgb="FF605E5C"/><name val="Calibri"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFEDEBE9"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left/><right/><top/><bottom style="thin"><color rgb="FF8A8886"/></bottom><diagonal/></border>` +
  `<border><left/><right/><top style="thin"><color rgb="FF8A8886"/></top><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="7">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  // Rubrikrad: fet, grå botten, linje under.
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
  // Rubrik för hela bladet.
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  // Grå, kursiv notering.
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  // Summarad: fet, linje över.
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** Bladnamn: högst 31 tecken, utan tecknen Excel förbjuder, och unika. */
export function sheetNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const base = String(raw ?? "").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * @param {Sheet[]} sheets
 * @returns {Uint8Array} en färdig .xlsx
 */
export function buildXlsx(sheets, when = new Date()) {
  const encoder = new TextEncoder();
  const names = sheetNames(sheets.map((s) => s.name));
  const file = (name, text) => ({ name, data: encoder.encode(text) });

  const sheetEntries = sheets.map((_, i) => i + 1);

  return zip(
    [
      file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          sheetEntries
            .map(
              (n) =>
                `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
            )
            .join("") +
          `</Types>`
      ),
      file(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`
      ),
      file(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
          names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
          `</sheets></workbook>`
      ),
      file(
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          sheetEntries
            .map(
              (n) =>
                `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`
            )
            .join("") +
          `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `</Relationships>`
      ),
      file("xl/styles.xml", STYLES),
      ...sheets.map((sheet, i) => file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)))
    ],
    when
  );
}
