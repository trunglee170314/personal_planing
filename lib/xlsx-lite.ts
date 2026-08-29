import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export type WorkbookSheet = { name: string; rows: string[][] };

const xmlEscape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const xmlDecode = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );

function columnNumber(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let result = 0;
  for (const letter of letters)
    result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function textNodes(value: string) {
  return [...value.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => xmlDecode(match[1]))
    .join('');
}

function workbookRelations(xml: string) {
  return new Map(
    [...xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((match) => {
      const attrs = match[1];
      const id = attrs.match(/\bId="([^"]+)"/)?.[1] ?? '';
      const target = attrs.match(/\bTarget="([^"]+)"/)?.[1] ?? '';
      return [id, target] as const;
    }),
  );
}

export function readXlsx(buffer: ArrayBuffer): WorkbookSheet[] {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (path: string) => {
    const bytes = files[path];
    if (!bytes) throw new Error(`Invalid workbook: missing ${path}.`);
    return strFromU8(bytes);
  };
  const shared = files['xl/sharedStrings.xml']
    ? [...read('xl/sharedStrings.xml').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(
        (match) => textNodes(match[1]),
      )
    : [];
  const relationships = workbookRelations(read('xl/_rels/workbook.xml.rels'));
  const workbook = read('xl/workbook.xml');
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map(
    (match) => {
      const attrs = match[1];
      return {
        name: xmlDecode(attrs.match(/\bname="([^"]+)"/)?.[1] ?? 'Sheet'),
        relation:
          attrs.match(/\br:id="([^"]+)"/)?.[1] ??
          attrs.match(/\bid="([^"]+)"/)?.[1] ??
          '',
      };
    },
  );
  return sheets.map(({ name, relation }) => {
    const target = relationships.get(relation);
    if (!target) throw new Error(`Invalid workbook relation for ${name}.`);
    const path = target.startsWith('/')
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, '')}`;
    const xml = read(path);
    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(
        /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
      )) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const index = columnNumber(attrs.match(/\br="([^"]+)"/)?.[1] ?? 'A1');
        const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? '';
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        const value =
          type === 's'
            ? (shared[Number(raw)] ?? '')
            : type === 'inlineStr'
              ? textNodes(body)
              : type === 'b'
                ? raw === '1'
                  ? 'true'
                  : 'false'
                : xmlDecode(raw);
        row[index] = value;
      }
      rows.push(Array.from({ length: row.length }, (_, index) => row[index] ?? ''));
    }
    return { name, rows };
  });
}

const workbookXml = (sheets: WorkbookSheet[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
  .map(
    (sheet, index) =>
      `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
  )
  .join('')}</sheets></workbook>`;

function columnName(index: number) {
  let value = index + 1;
  let result = '';
  while (value) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sheetXml(rows: string[][]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (cell, columnIndex) =>
              `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`;
}

export function writeXlsx(sheets: WorkbookSheet[]) {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(workbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet.rows));
  });
  return zipSync(files, { level: 6 });
}
