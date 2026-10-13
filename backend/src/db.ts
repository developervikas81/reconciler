import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  MatchDraft,
  MatchStatus,
  ReceiptDraft,
  ReceiptView,
  Report,
  ReportRow,
  StatementDraft,
  StatementView,
} from "./types.js";

const defaultDbPath = path.resolve(process.cwd(), "data", "reconciler.db");

type SqlRow = Record<string, number | bigint | string | null>;

function asNumber(value: number | bigint | string | null): number | null {
  if (value == null) return null;
  return Number(value);
}

function asString(value: number | bigint | string | null): string | null {
  if (value == null) return null;
  return String(value);
}

export function openDatabase(dbPath = defaultDbPath): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL UNIQUE,
      merchant TEXT,
      amount_fils INTEGER,
      txn_date TEXT,
      txn_time TEXT,
      receipt_number TEXT,
      card_last4 TEXT,
      raw_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS statement_lines (
      id INTEGER PRIMARY KEY,
      txn_date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_fils INTEGER NOT NULL,
      card_last4 TEXT,
      ref TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      receipt_id INTEGER REFERENCES receipts(id) ON DELETE CASCADE,
      statement_line_id INTEGER REFERENCES statement_lines(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('matched', 'duplicate', 'missing', 'mismatch')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (receipt_id IS NOT NULL OR statement_line_id IS NOT NULL),
      CHECK (
        (status = 'missing' AND ((receipt_id IS NULL) + (statement_line_id IS NULL)) = 1)
        OR (status IN ('matched', 'mismatch') AND receipt_id IS NOT NULL AND statement_line_id IS NOT NULL)
        OR (status = 'duplicate' AND receipt_id IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_receipt
      ON matches(receipt_id) WHERE receipt_id IS NOT NULL;

    DROP INDEX IF EXISTS idx_receipts_number;
  `);

  return db;
}

export function clearTables(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM matches");
    db.exec("DELETE FROM receipts");
    db.exec("DELETE FROM statement_lines");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadReceiptDrafts(db: DatabaseSync): ReceiptDraft[] {
  const rows = db.prepare(`
    SELECT file_name, merchant, amount_fils, txn_date, txn_time, receipt_number, card_last4, raw_text
    FROM receipts
    ORDER BY id
  `).all() as SqlRow[];

  return rows.map((row) => ({
    fileName: String(row.file_name),
    merchant: asString(row.merchant),
    amountFils: asNumber(row.amount_fils),
    txnDate: asString(row.txn_date),
    txnTime: asString(row.txn_time),
    receiptNumber: asString(row.receipt_number),
    cardLast4: asString(row.card_last4),
    rawText: String(row.raw_text ?? ""),
  }));
}

export function loadStatementDrafts(db: DatabaseSync): StatementDraft[] {
  const rows = db.prepare(`
    SELECT txn_date, description, amount_fils, card_last4, ref
    FROM statement_lines
    ORDER BY id
  `).all() as SqlRow[];

  return rows.map((row) => ({
    txnDate: String(row.txn_date),
    description: String(row.description),
    amountFils: Number(row.amount_fils),
    cardLast4: asString(row.card_last4),
    ref: String(row.ref),
  }));
}

export function addReceiptsAndRematch(
  db: DatabaseSync,
  newReceipts: ReceiptDraft[],
  replacementLines: StatementDraft[] | null,
  matches: MatchDraft[],
): void {
  const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      file_name, merchant, amount_fils, txn_date, txn_time, receipt_number, card_last4, raw_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLine = db.prepare(`
    INSERT INTO statement_lines (txn_date, description, amount_fils, card_last4, ref)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMatch = db.prepare(`
    INSERT INTO matches (receipt_id, statement_line_id, status, reason)
    VALUES (?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    for (const receipt of newReceipts) {
      insertReceipt.run(
        receipt.fileName,
        receipt.merchant,
        receipt.amountFils,
        receipt.txnDate,
        receipt.txnTime,
        receipt.receiptNumber,
        receipt.cardLast4,
        receipt.rawText,
      );
    }

    db.exec("DELETE FROM matches");
    if (replacementLines) db.exec("DELETE FROM statement_lines");

    const receiptIds = new Map<string, number>();
    for (const row of db.prepare(`SELECT id, file_name FROM receipts`).all() as SqlRow[]) {
      receiptIds.set(String(row.file_name), Number(row.id));
    }

    const lineIds = new Map<string, number>();
    if (replacementLines) {
      for (const line of replacementLines) {
        const result = insertLine.run(line.txnDate, line.description, line.amountFils, line.cardLast4, line.ref);
        lineIds.set(line.ref, Number(result.lastInsertRowid));
      }
    } else {
      for (const row of db.prepare(`SELECT id, ref FROM statement_lines`).all() as SqlRow[]) {
        lineIds.set(String(row.ref), Number(row.id));
      }
    }

    for (const match of matches) {
      const receiptId = match.fileName ? receiptIds.get(match.fileName) ?? null : null;
      const lineId = match.ref ? lineIds.get(match.ref) ?? null : null;
      if (match.fileName && receiptId == null) {
        throw new Error(`Match refers to unknown receipt ${match.fileName}.`);
      }
      if (match.ref && lineId == null) {
        throw new Error(`Match refers to unknown statement ${match.ref}.`);
      }
      insertMatch.run(receiptId, lineId, match.status, match.reason);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function replaceRun(
  db: DatabaseSync,
  receipts: ReceiptDraft[],
  lines: StatementDraft[],
  matches: MatchDraft[],
): void {
  const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      file_name, merchant, amount_fils, txn_date, txn_time, receipt_number, card_last4, raw_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLine = db.prepare(`
    INSERT INTO statement_lines (txn_date, description, amount_fils, card_last4, ref)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMatch = db.prepare(`
    INSERT INTO matches (receipt_id, statement_line_id, status, reason)
    VALUES (?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM matches");
    db.exec("DELETE FROM receipts");
    db.exec("DELETE FROM statement_lines");

    const receiptIds = new Map<string, number>();
    for (const receipt of receipts) {
      const result = insertReceipt.run(
        receipt.fileName,
        receipt.merchant,
        receipt.amountFils,
        receipt.txnDate,
        receipt.txnTime,
        receipt.receiptNumber,
        receipt.cardLast4,
        receipt.rawText,
      );
      receiptIds.set(receipt.fileName, Number(result.lastInsertRowid));
    }

    const lineIds = new Map<string, number>();
    for (const line of lines) {
      const result = insertLine.run(
        line.txnDate,
        line.description,
        line.amountFils,
        line.cardLast4,
        line.ref,
      );
      lineIds.set(line.ref, Number(result.lastInsertRowid));
    }

    for (const match of matches) {
      const receiptId = match.fileName ? receiptIds.get(match.fileName) ?? null : null;
      const lineId = match.ref ? lineIds.get(match.ref) ?? null : null;
      if (match.fileName && receiptId == null) {
        throw new Error(`Match refers to unknown receipt ${match.fileName}.`);
      }
      if (match.ref && lineId == null) {
        throw new Error(`Match refers to unknown statement ${match.ref}.`);
      }
      insertMatch.run(receiptId, lineId, match.status, match.reason);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadReport(db: DatabaseSync): Report {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM receipts) AS receipt_count,
      (SELECT COUNT(*) FROM statement_lines) AS statement_count,
      (SELECT MAX(created_at) FROM matches) AS ran_at
  `).get() as SqlRow;

  const rows = db.prepare(`
    SELECT
      m.id AS id,
      m.status AS status,
      m.reason AS reason,
      r.id AS r_id,
      r.file_name AS r_file_name,
      r.merchant AS r_merchant,
      r.amount_fils AS r_amount_fils,
      r.txn_date AS r_txn_date,
      r.txn_time AS r_txn_time,
      r.receipt_number AS r_receipt_number,
      r.card_last4 AS r_card_last4,
      r.raw_text AS r_raw_text,
      s.id AS s_id,
      s.txn_date AS s_txn_date,
      s.description AS s_description,
      s.amount_fils AS s_amount_fils,
      s.card_last4 AS s_card_last4,
      s.ref AS s_ref
    FROM matches m
    LEFT JOIN receipts r ON r.id = m.receipt_id
    LEFT JOIN statement_lines s ON s.id = m.statement_line_id
    ORDER BY
      CASE m.status
        WHEN 'matched' THEN 1
        WHEN 'mismatch' THEN 2
        WHEN 'duplicate' THEN 3
        ELSE 4
      END,
      COALESCE(r.txn_date, s.txn_date),
      COALESCE(r.file_name, s.ref)
  `).all() as SqlRow[];

  const reportRows: ReportRow[] = rows.map((row) => ({
    id: Number(row.id),
    status: String(row.status) as MatchStatus,
    reason: String(row.reason),
    receipt: row.r_id == null ? null : toReceipt(row),
    statementLine: row.s_id == null ? null : toStatement(row),
  }));

  const summary = {
    receiptCount: Number(counts.receipt_count ?? 0),
    statementCount: Number(counts.statement_count ?? 0),
    matched: reportRows.filter((row) => row.status === "matched").length,
    duplicate: reportRows.filter((row) => row.status === "duplicate").length,
    mismatch: reportRows.filter((row) => row.status === "mismatch").length,
    missingReceiptSide: reportRows.filter((row) => row.status === "missing" && row.receipt && !row.statementLine).length,
    missingStatementSide: reportRows.filter((row) => row.status === "missing" && row.statementLine && !row.receipt).length,
  };

  return {
    hasRun: summary.receiptCount > 0 || summary.statementCount > 0,
    ranAt: asString(counts.ran_at),
    summary,
    rows: reportRows,
  };
}

function toReceipt(row: SqlRow): ReceiptView {
  return {
    id: Number(row.r_id),
    fileName: String(row.r_file_name),
    merchant: asString(row.r_merchant),
    amountFils: asNumber(row.r_amount_fils),
    txnDate: asString(row.r_txn_date),
    txnTime: asString(row.r_txn_time),
    receiptNumber: asString(row.r_receipt_number),
    cardLast4: asString(row.r_card_last4),
    rawText: String(row.r_raw_text ?? ""),
  };
}

function toStatement(row: SqlRow): StatementView {
  return {
    id: Number(row.s_id),
    txnDate: String(row.s_txn_date),
    description: String(row.s_description),
    amountFils: Number(row.s_amount_fils),
    cardLast4: asString(row.s_card_last4),
    ref: String(row.s_ref),
  };
}
