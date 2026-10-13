import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStatementCsv } from "./csv.js";
import { loadReport, openDatabase, replaceRun } from "./db.js";
import { parseReceiptText } from "./extract.js";
import { reconcile } from "./reconcile.js";
import type { ReceiptDraft } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(here, "..", "..", "assets");

const sample = `
Sheraton Grand
Sheikh Zayed Rd
TRN 100535289
Date: 13/06/2026  16:48
Receipt: R19089
Room 2 nights                 1,180.95
Subtotal                      1,180.95
VAT 5%                           59.05
TOTAL (AED)                   1,240.00
VISA ****4417 APPROVED
`;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const parsed = parseReceiptText("receipt-01.png", sample);
assert(parsed.merchant === "Sheraton Grand", `merchant was ${parsed.merchant}`);
assert(parsed.amountFils === 124000, `amount was ${parsed.amountFils}`);
assert(parsed.txnDate === "2026-06-13", `date was ${parsed.txnDate}`);
assert(parsed.txnTime === "16:48", `time was ${parsed.txnTime}`);
assert(parsed.receiptNumber === "R19089", `receipt was ${parsed.receiptNumber}`);
assert(parsed.cardLast4 === "4417", `card was ${parsed.cardLast4}`);

const receipts: ReceiptDraft[] = [
  receipt("receipt-01.png", "Sheraton Grand", 124000, "2026-06-13", "16:48", "R19089", "4417"),
  receipt("receipt-02.png", "Jumeirah Beach Cafe", 24000, "2026-06-22", "08:35", "R38155", "9921"),
  receipt("receipt-03.png", "Noon.com", 8450, "2026-06-18", "17:40", "R52446", "4417"),
  receipt("receipt-04.png", "Amazon.ae", 12999, "2026-06-10", "18:56", "R65862", "4417"),
  receipt("receipt-05.png", "Carrefour", 21345, "2026-06-06", "16:27", "R24352", "4417"),
  receipt("receipt-06.png", "Spinneys", 7630, "2026-06-14", "21:04", "R16475", "4417"),
  receipt("receipt-07.png", "Uber", 3820, "2026-06-11", "13:21", "R40650", "4417"),
  receipt("receipt-08.png", "Careem", 4750, "2026-06-02", "18:52", "R68014", "4417"),
  receipt("receipt-09.png", "Zuma Restaurant", 59000, "2026-06-09", "16:01", "R12752", "4417"),
  receipt("receipt-10.png", "Starbucks", 4100, "2026-06-25", "10:46", "R10182", "4417"),
  receipt("receipt-11.png", "McDonald's", 4500, "2026-06-16", "13:01", "R18936", "4417"),
  receipt("receipt-12.png", "Talabat", 8800, "2026-06-03", "21:01", "R28210", "4417"),
  receipt("receipt-13.png", "Talabat", 6775, "2026-06-21", "15:49", "TLB-77310", "4417"),
  receipt("receipt-14.png", "WeWork", 35000, "2026-06-24", "13:29", "R61272", "4417"),
  receipt("receipt-15.png", "du Telecom", 29900, "2026-06-12", "14:57", "R21411", "4417"),
  receipt("receipt-16.png", "Office Depot LLC", 6400, "2026-06-07", "14:33", "R64972", "4417"),
  receipt("receipt-17.png", "Talabat", 6775, "2026-06-21", "09:13", "TLB-77310", "4417"),
  receipt("receipt-18.png", "Careem", 5200, "2026-06-20", "10:44", "R52491", "4417"),
  receipt("receipt-19.png", "Emirates Airline", 215000, "2026-06-17", "08:58", "R14299", "4417"),
  receipt("receipt-20.png", "Starbucks", 3200, "2026-06-03", "21:37", "R91249", "4417"),
];

const statement = parseStatementCsv(readFileSync(path.join(assetsDir, "card-statement.csv"), "utf8"));
const matches = reconcile(receipts, statement);

function byFile(fileName: string) {
  return matches.find((match) => match.fileName === fileName);
}

function expectMatch(fileName: string, status: string, ref: string | null) {
  const match = byFile(fileName);
  assert(match, `${fileName} missing`);
  assert(match.status === status && match.ref === ref, `${fileName} got ${match.status} ${match.ref}, expected ${status} ${ref}`);
}

expectMatch("receipt-01.png", "matched", "TXN172775");
expectMatch("receipt-02.png", "missing", null);
expectMatch("receipt-03.png", "matched", "TXN116229");
expectMatch("receipt-04.png", "matched", "TXN643430");
expectMatch("receipt-05.png", "matched", "TXN585052");
expectMatch("receipt-06.png", "matched", "TXN751828");
expectMatch("receipt-07.png", "matched", "TXN793206");
expectMatch("receipt-08.png", "matched", "TXN307023");
expectMatch("receipt-09.png", "mismatch", "TXN303503");
expectMatch("receipt-10.png", "mismatch", "TXN610033");
expectMatch("receipt-11.png", "matched", "TXN627277");
expectMatch("receipt-12.png", "matched", "TXN618239");
expectMatch("receipt-13.png", "matched", "TXN668675");
expectMatch("receipt-14.png", "matched", "TXN765768");
expectMatch("receipt-15.png", "matched", "TXN214694");
expectMatch("receipt-16.png", "matched", "TXN756349");
expectMatch("receipt-17.png", "duplicate", "TXN668675");
expectMatch("receipt-18.png", "matched", "TXN860807");
expectMatch("receipt-19.png", "matched", "TXN554751");
expectMatch("receipt-20.png", "matched", "TXN781696");

const missingRefs = matches.filter((match) => match.fileName == null).map((match) => match.ref).sort();
assert(missingRefs.join() === "TXN157009,TXN205742", `unexpected statement gaps: ${missingRefs.join()}`);

const lag = byFile("receipt-12.png");
assert(lag?.reason.includes("1 day after"), `lag reason was: ${lag?.reason}`);
assert(byFile("receipt-01.png")?.reason === "Merchant, date, and amount all agree.", "clean match was worded like a flag");

const db = openDatabase(":memory:");
for (const item of receipts) item.rawText = item.fileName;
replaceRun(db, receipts, statement, matches);
const report = loadReport(db);
assert(report.summary.matched === 16, `matched ${report.summary.matched}`);
assert(report.summary.duplicate === 1, `duplicate ${report.summary.duplicate}`);
assert(report.summary.mismatch === 2, `mismatch ${report.summary.mismatch}`);
assert(report.summary.missingReceiptSide === 1, `missing receipts ${report.summary.missingReceiptSide}`);
assert(report.summary.missingStatementSide === 2, `missing lines ${report.summary.missingStatementSide}`);
assert(report.rows.length === 22, `rows ${report.rows.length}`);

console.log("Reconciliation checks passed.");

function receipt(
  fileName: string,
  merchant: string,
  amountFils: number,
  txnDate: string,
  txnTime: string,
  receiptNumber: string,
  cardLast4: string,
): ReceiptDraft {
  return {
    fileName,
    merchant,
    amountFils,
    txnDate,
    txnTime,
    receiptNumber,
    cardLast4,
    rawText: "",
  };
}
