// xlsx-skrivaren: zip-behållaren, cellerna och att det Excel kräver finns med.

import { test, assert } from "./tree.test.js";
import { crc32, zip, buildXlsx, escapeXml, columnName, sheetNames, excelDate } from "../src/common/xlsx.js";

/** Läser tillbaka en zip utan komprimering: namn → text. */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    files.set(name, { text: decoder.decode(data), crcOk: crc32(data) === crc });
    at += 30 + nameLength + size;
  }
  // Slutposten ska peka på den centrala katalogen, som börjar där filerna slutar.
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "slutpost");
  assert.equal(view.getUint32(end + 16, true), at, "katalogens position");
  assert.equal(view.getUint16(end + 10, true), files.size, "antal filer");
  return files;
}

test("xlsx: CRC-32 som zip räknar den", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "standardvektorn");
  assert.equal(crc32(new Uint8Array()), 0, "tomt");
});

test("xlsx: kolumnbokstäver, bladnamn och XML-tecken", () => {
  assert.same([0, 25, 26, 701, 702].map(columnName), ["A", "Z", "AA", "ZZ", "AAA"], "kolumner");
  assert.same(sheetNames(["Enheter", "enheter", "a/b:c", "x".repeat(40), ""]), ["Enheter", "enheter 2", "a b c", "x".repeat(31), "Sheet"], "bladnamn");
  assert.equal(escapeXml(`<a & "b">\u0001`), "&lt;a &amp; &quot;b&quot;&gt;", "escape och styrtecken bort");
  assert.equal(excelDate(new Date(Date.UTC(1970, 0, 1))), 25569, "epoken");
});

test("xlsx: arbetsboken har blad, rubriker, datum, fetstil och autofilter", () => {
  const bytes = buildXlsx([
    {
      name: "Översikt",
      filter: false,
      columns: [{ header: "Kommun", width: 20 }, { header: "IPad" }],
      rows: [["Heby", 1472], [{ value: "Totalsumma", bold: true }, { value: 5308, bold: true }]]
    },
    {
      name: "Enheter",
      columns: [{ header: "deviceName" }, { header: "lastSyncDateTime" }, { header: "tom" }],
      rows: [["K-LS <1> & Ö", new Date(Date.UTC(2026, 8, 29, 12)), null]]
    }
  ]);

  const files = unzip(bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
    assert.ok(files.has(name), name);
    assert.ok(files.get(name).crcOk, `${name}: crc`);
  }

  const workbook = files.get("xl/workbook.xml").text;
  assert.ok(workbook.includes(`name="Översikt"`) && workbook.includes(`name="Enheter"`), "bladnamn i UTF-8");

  const overview = files.get("xl/worksheets/sheet1.xml").text;
  assert.ok(overview.includes(`<c r="B2"><v>1472</v></c>`), "tal");
  assert.ok(overview.includes(`<c r="A3" s="1" t="inlineStr">`), "fet summarad");
  assert.ok(overview.includes(`state="frozen"`), "låst rubrikrad");
  assert.notOk(overview.includes("<autoFilter"), "inget filter på översikten");
  assert.ok(overview.includes(`width="20"`), "kolumnbredd");

  const devices = files.get("xl/worksheets/sheet2.xml").text;
  assert.ok(devices.includes("K-LS &lt;1&gt; &amp; Ö"), "text escapas");
  assert.ok(/<c r="B2" s="2"><v>46294\.5<\/v><\/c>/.test(devices), "datum som serienummer med datumformat");
  assert.notOk(devices.includes(`r="C2"`), "tom cell skrivs inte");
  assert.ok(devices.includes(`<autoFilter ref="A1:C2"/>`), "autofilter över allt");
});

test("xlsx: fritt blad med rubrik, stilar, filter på ett område och låsta rader", () => {
  const files = unzip(
    buildXlsx([
      {
        name: "Report",
        grid: [
          [{ value: "Intune device report", style: "title" }],
          [{ value: "urval", style: "muted" }, null, { value: "Kommun", style: "header" }],
          [],
          [{ value: "Device name", style: "header" }],
          ["T-1", null, { value: 3, style: "total" }]
        ],
        widths: [28, 0, 12],
        autoFilter: "A4:A5",
        freezeRow: 5
      }
    ])
  );
  const sheet = files.get("xl/worksheets/sheet1.xml").text;
  assert.ok(sheet.includes(`<c r="A1" s="4" t="inlineStr">`), "rubrik");
  assert.ok(sheet.includes(`<c r="A2" s="5" t="inlineStr">`), "notering");
  assert.ok(sheet.includes(`<c r="C2" s="3" t="inlineStr">`), "tabellrubrik");
  assert.ok(sheet.includes(`<c r="C5" s="6"><v>3</v></c>`), "summarad");
  assert.notOk(sheet.includes(`<row r="3">`), "tom rad skrivs inte");
  assert.ok(sheet.includes(`<autoFilter ref="A4:A5"/>`), "filter på området");
  assert.ok(sheet.includes(`ySplit="4" topLeftCell="A5"`), "raderna ovanför 5 låsta");
  assert.notOk(sheet.includes(`min="2" max="2"`), "bredd 0 = standard");
  assert.ok(files.get("xl/styles.xml").text.includes(`<cellXfs count="7">`), "sju stilar");
});

test("xlsx: zip med flera filer går att läsa tillbaka", () => {
  const encoder = new TextEncoder();
  const files = unzip(zip([{ name: "a.txt", data: encoder.encode("hej") }, { name: "mapp/å.txt", data: encoder.encode("") }]));
  assert.equal(files.get("a.txt").text, "hej", "innehåll");
  assert.ok(files.has("mapp/å.txt"), "UTF-8-namn");
});
