export type CsvRow = Record<string, string>;

// Strips a leading BOM, which would otherwise prefix the first header name.
export function parseCsv(text: string): CsvRow[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quoted) {
      if (char === '"') {
        if (clean[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[index + 1] === "\n") {
        index += 1;
      }
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") {
        rows.push(record);
      }
      record = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    if (record.length > 1 || record[0] !== "") {
      rows.push(record);
    }
  }
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const row: CsvRow = {};
    for (let column = 0; column < header.length; column++) {
      row[header[column]] = cells[column] ?? "";
    }
    return row;
  });
}
