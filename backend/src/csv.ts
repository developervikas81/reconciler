import { parseMoneyToFils } from "./money.js";
import type { StatementDraft } from "./types.js";

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());
  return cells;
}

export function parseStatementCsv(text: string): StatementDraft[] {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("The statement CSV has no data rows.");
  }

  const headers = splitCsvLine(lines[0]).map((header) => header.toLowerCase());
  const index = (name: string) => headers.indexOf(name);
  const dateIdx = index("date");
  const descriptionIdx = index("description");
  const amountIdx = index("amount_aed");
  const cardIdx = index("card_last4");
  const refIdx = index("ref");

  if (dateIdx < 0 || descriptionIdx < 0 || amountIdx < 0 || refIdx < 0) {
    throw new Error("Statement CSV must include date, description, amount_aed, and ref.");
  }

  return lines.slice(1).map((line, rowNumber) => {
    const cells = splitCsvLine(line);
    const amount = parseMoneyToFils(cells[amountIdx] ?? "");
    const txnDate = cells[dateIdx] ?? "";
    const ref = cells[refIdx] ?? "";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate) || amount == null || !ref) {
      throw new Error(`Could not read statement row ${rowNumber + 2}.`);
    }

    return {
      txnDate,
      description: cells[descriptionIdx] ?? "",
      amountFils: amount,
      cardLast4: cardIdx >= 0 ? cells[cardIdx] || null : null,
      ref,
    };
  });
}
