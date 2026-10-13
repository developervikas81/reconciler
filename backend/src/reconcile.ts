import { formatAed } from "./money.js";
import type { MatchDraft, ReceiptDraft, StatementDraft } from "./types.js";

const NOISE = new Set([
  "llc",
  "fz",
  "ae",
  "uae",
  "dubai",
  "payment",
  "payments",
  "distribution",
  "the",
  "com",
  "web",
  "www",
  "trip",
  "ride",
  "food",
  "delivery",
  "postpaid",
  "store",
  "online",
  "order",
  "grand",
  "hotel",
  "help",
  "telecom",
  "restaurant",
  "airline",
  "cafe",
  "beach",
  "bill",
  "approved",
  "visa",
  "aed",
  "trn",
]);

export function merchantTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !NOISE.has(token));
}

export function merchantScore(left: string, right: string): number {
  const leftTokens = merchantTokens(left);
  const rightTokens = merchantTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const rightSet = new Set(rightTokens);
  const leftSet = new Set(leftTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token));
  const brandHit = rightSet.has(leftTokens[0]) || leftSet.has(rightTokens[0]);
  if (!brandHit || overlap.length === 0) return 0;
  return overlap.length * 10 + 15;
}

function dayDiff(receiptDate: string, statementDate: string): number {
  const receipt = Date.parse(`${receiptDate}T00:00:00Z`);
  const statement = Date.parse(`${statementDate}T00:00:00Z`);
  return Math.round((statement - receipt) / 86_400_000);
}

function dateScore(receiptDate: string, statementDate: string): number {
  const diff = Math.abs(dayDiff(receiptDate, statementDate));
  if (diff === 0) return 50;
  if (diff === 1) return 25;
  return 0;
}

function cardsCompatible(receiptCard: string | null, statementCard: string | null): boolean {
  if (!receiptCard || !statementCard) return true;
  return receiptCard === statementCard;
}

function samePurchase(left: ReceiptDraft, right: ReceiptDraft): boolean {
  const leftNumber = left.receiptNumber?.toUpperCase() ?? "";
  const rightNumber = right.receiptNumber?.toUpperCase() ?? "";
  if (leftNumber && rightNumber) return leftNumber === rightNumber;
  if (!left.merchant || !right.merchant || left.amountFils == null || right.amountFils == null) return false;
  return (
    left.amountFils === right.amountFils &&
    left.txnDate === right.txnDate &&
    merchantScore(left.merchant, right.merchant) > 0
  );
}

function readable(receipt: ReceiptDraft): receipt is ReceiptDraft & {
  merchant: string;
  amountFils: number;
  txnDate: string;
} {
  return Boolean(receipt.merchant && receipt.amountFils != null && receipt.txnDate);
}

function matchedReason(receiptDate: string, statementDate: string): string {
  const diff = dayDiff(receiptDate, statementDate);
  if (diff === 0) return "Merchant, date, and amount all agree.";
  const days = Math.abs(diff);
  const unit = days === 1 ? "day" : "days";
  if (diff > 0) {
    return `Merchant and amount agree. The statement posted ${days} ${unit} after the receipt.`;
  }
  return `Merchant and amount agree. The statement date is ${days} ${unit} before the receipt.`;
}

export function reconcile(receipts: ReceiptDraft[], lines: StatementDraft[]): MatchDraft[] {
  const matches: MatchDraft[] = [];
  const usedReceipts = new Set<number>();
  const explainedLines = new Set<number>();
  const lineOwner = new Map<number, number>();

  receipts.forEach((receipt, index) => {
    if (readable(receipt)) return;
    usedReceipts.add(index);
    matches.push({
      fileName: receipt.fileName,
      ref: null,
      status: "missing",
      reason: "Could not read merchant, amount, or date from this photo.",
    });
  });

  const exactPairs: { receiptIndex: number; lineIndex: number; score: number }[] = [];

  receipts.forEach((receipt, receiptIndex) => {
    if (!readable(receipt)) return;
    lines.forEach((line, lineIndex) => {
      if (!cardsCompatible(receipt.cardLast4, line.cardLast4)) return;
      if (receipt.amountFils !== line.amountFils) return;
      const nameScore = merchantScore(receipt.merchant, line.description);
      const whenScore = dateScore(receipt.txnDate, line.txnDate);
      if (nameScore === 0 || whenScore === 0) return;
      exactPairs.push({ receiptIndex, lineIndex, score: nameScore + whenScore });
    });
  });

  exactPairs.sort(
    (a, b) =>
      b.score - a.score ||
      receipts[a.receiptIndex].fileName.localeCompare(receipts[b.receiptIndex].fileName) ||
      lines[a.lineIndex].ref.localeCompare(lines[b.lineIndex].ref),
  );

  for (const pair of exactPairs) {
    if (usedReceipts.has(pair.receiptIndex)) continue;
    const receipt = receipts[pair.receiptIndex];
    const line = lines[pair.lineIndex];

    if (!lineOwner.has(pair.lineIndex)) {
      lineOwner.set(pair.lineIndex, pair.receiptIndex);
      usedReceipts.add(pair.receiptIndex);
      explainedLines.add(pair.lineIndex);
      matches.push({
        fileName: receipt.fileName,
        ref: line.ref,
        status: "matched",
        reason: matchedReason(receipt.txnDate!, line.txnDate),
      });
      continue;
    }

    const owner = receipts[lineOwner.get(pair.lineIndex)!];
    if (!samePurchase(receipt, owner)) continue;

    usedReceipts.add(pair.receiptIndex);
    const number = receipt.receiptNumber ?? owner.receiptNumber;
    const reason = number
      ? `Duplicate of ${owner.fileName} (receipt ${number}). The statement line is already matched.`
      : `Duplicate of ${owner.fileName}: same merchant, date, and amount. The statement line is already matched.`;
    matches.push({
      fileName: receipt.fileName,
      ref: line.ref,
      status: "duplicate",
      reason,
    });
  }

  const mismatchPairs: { receiptIndex: number; lineIndex: number; score: number }[] = [];

  receipts.forEach((receipt, receiptIndex) => {
    if (!readable(receipt) || usedReceipts.has(receiptIndex)) return;
    lines.forEach((line, lineIndex) => {
      if (explainedLines.has(lineIndex)) return;
      if (!cardsCompatible(receipt.cardLast4, line.cardLast4)) return;
      if (receipt.amountFils === line.amountFils) return;
      if (dayDiff(receipt.txnDate, line.txnDate) !== 0) return;
      const nameScore = merchantScore(receipt.merchant, line.description);
      if (nameScore === 0) return;
      mismatchPairs.push({ receiptIndex, lineIndex, score: nameScore });
    });
  });

  mismatchPairs.sort(
    (a, b) =>
      b.score - a.score ||
      receipts[a.receiptIndex].fileName.localeCompare(receipts[b.receiptIndex].fileName),
  );

  for (const pair of mismatchPairs) {
    if (usedReceipts.has(pair.receiptIndex) || explainedLines.has(pair.lineIndex)) continue;
    const receipt = receipts[pair.receiptIndex];
    const line = lines[pair.lineIndex];
    usedReceipts.add(pair.receiptIndex);
    explainedLines.add(pair.lineIndex);
    const delta = Math.abs(receipt.amountFils! - line.amountFils);
    matches.push({
      fileName: receipt.fileName,
      ref: line.ref,
      status: "mismatch",
      reason: `Same merchant and date, but the amounts differ by ${formatAed(delta)} (receipt ${formatAed(receipt.amountFils!)}, statement ${formatAed(line.amountFils)}).`,
    });
  }

  receipts.forEach((receipt, index) => {
    if (usedReceipts.has(index)) return;
    let reason = "No statement line matched this receipt.";
    if (receipt.cardLast4 && !lines.some((line) => line.cardLast4 === receipt.cardLast4)) {
      reason += ` Card ending ${receipt.cardLast4} is not on this statement.`;
    }
    matches.push({ fileName: receipt.fileName, ref: null, status: "missing", reason });
  });

  lines.forEach((line, index) => {
    if (explainedLines.has(index)) return;
    matches.push({
      fileName: null,
      ref: line.ref,
      status: "missing",
      reason: "No receipt matched this statement line.",
    });
  });

  return matches;
}
