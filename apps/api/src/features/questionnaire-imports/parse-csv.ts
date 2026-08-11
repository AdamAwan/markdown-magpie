// RFC-4180 reader for an uploaded CSV questionnaire. Written here rather than
// taken as a dependency: the whole requirement is "text in, string[][] out", and
// the two things real questionnaire exports get wrong (a BOM, and a semicolon or
// tab delimiter from a European Excel) are both a couple of lines.

const DELIMITERS = [",", ";", "\t"] as const;

// Count each candidate delimiter in the first line, OUTSIDE quotes: a comma
// inside a quoted question must not vote for itself.
function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((delimiter) => [delimiter, 0]));
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) {
      continue;
    }
    if (char === "\n") {
      break;
    }
    const count = counts.get(char);
    if (count !== undefined) {
      counts.set(char, count + 1);
    }
  }
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string): string[][] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const delimiter = sniffDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // \r\n ends one row, not two.
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
