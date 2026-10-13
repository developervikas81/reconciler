export type MatchStatus = "matched" | "duplicate" | "missing" | "mismatch";

export type ReceiptDraft = {
  fileName: string;
  merchant: string | null;
  amountFils: number | null;
  txnDate: string | null;
  txnTime: string | null;
  receiptNumber: string | null;
  cardLast4: string | null;
  rawText: string;
};

export type StatementDraft = {
  txnDate: string;
  description: string;
  amountFils: number;
  cardLast4: string | null;
  ref: string;
};

export type MatchDraft = {
  fileName: string | null;
  ref: string | null;
  status: MatchStatus;
  reason: string;
};

export type ReceiptView = {
  id: number;
  fileName: string;
  merchant: string | null;
  amountFils: number | null;
  txnDate: string | null;
  txnTime: string | null;
  receiptNumber: string | null;
  cardLast4: string | null;
  rawText: string;
};

export type StatementView = {
  id: number;
  txnDate: string;
  description: string;
  amountFils: number;
  cardLast4: string | null;
  ref: string;
};

export type ReportRow = {
  id: number;
  status: MatchStatus;
  reason: string;
  receipt: ReceiptView | null;
  statementLine: StatementView | null;
};

export type Report = {
  hasRun: boolean;
  ranAt: string | null;
  summary: {
    receiptCount: number;
    statementCount: number;
    matched: number;
    duplicate: number;
    mismatch: number;
    missingReceiptSide: number;
    missingStatementSide: number;
  };
  rows: ReportRow[];
};
