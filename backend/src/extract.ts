import { parseMoneyToFils } from "./money.js";
import type { ReceiptDraft } from "./types.js";

export function parseReceiptText(fileName: string, rawText: string): ReceiptDraft {
  const text = rawText.replace(/\r/g, "");
  const dateMatch = text.match(
    /date\s*:\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\s+(\d{2}:\d{2}))?/i,
  );
  const receiptMatch = text.match(/receipt\s*:\s*([A-Za-z0-9-]+)/i);
  const totalMatch = text.match(
    /(?<!sub)\btotal\s*\(\s*aed\s*\)\s*([0-9][0-9,\s]*\.\d{2})/i,
  );
  const cardMatch = text.match(/\*{2,}\s*(\d{4})|(\d{4})\s+approved/i);

  const day = dateMatch?.[1]?.padStart(2, "0");
  const month = dateMatch?.[2]?.padStart(2, "0");
  const year = dateMatch?.[3];

  return {
    fileName,
    merchant: parseMerchant(text),
    amountFils: totalMatch ? parseMoneyToFils(totalMatch[1]) : null,
    txnDate: day && month && year ? `${year}-${month}-${day}` : null,
    txnTime: dateMatch?.[4] ?? null,
    receiptNumber: receiptMatch?.[1]?.toUpperCase() ?? null,
    cardLast4: cardMatch?.[1] ?? cardMatch?.[2] ?? null,
    rawText: text.trim(),
  };
}

function parseMerchant(text: string): string | null {
  const dateAt = text.search(/date\s*:/i);
  const head = dateAt === -1 ? text : text.slice(0, dateAt);
  const lines = head
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-\s]+$/.test(line));

  const merchant = lines.find((line) => /[A-Za-z]{3,}/.test(line) && !/^trn\b/i.test(line));
  return merchant ?? null;
}

export async function readReceiptImages(
  files: { fileName: string; filePath: string }[],
): Promise<ReceiptDraft[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  const receipts: ReceiptDraft[] = [];

  try {
    for (const file of files) {
      const result = await worker.recognize(file.filePath);
      const parsed = parseReceiptText(file.fileName, result.data.text);
      receipts.push(parsed);
      console.log(
        `${file.fileName}: ${parsed.merchant ?? "?"} ${parsed.amountFils ?? "?"} ${parsed.txnDate ?? "?"}`,
      );
    }
  } finally {
    await worker.terminate();
  }

  return receipts;
}
