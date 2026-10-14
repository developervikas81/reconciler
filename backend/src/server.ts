import cors from "cors";
import express from "express";
import multer from "multer";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseStatementCsv } from "./csv.js";
import { clearTables, countReceipts, insertReceipts, loadReceiptDrafts, loadReport, loadStatementDrafts, openDatabase, replaceMatches, replaceStatementLines } from "./db.js";
import { readReceiptImages } from "./extract.js";
import { reconcile } from "./reconcile.js";

const uploadRoot = path.resolve(process.cwd(), "data", "uploads");
const receiptsDir = path.join(uploadRoot, "receipts");
const port = Number(process.env.PORT ?? 3001);
const maxReceipts = 100;
const maxImageBytes = 50 * 1024;
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const db = openDatabase();
let running = false;

mkdirSync(receiptsDir, { recursive: true });

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes, files: maxReceipts },
});

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
});

function safeFileName(originalName: string, index: number): string {
  const base = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const extension = path.extname(base).toLowerCase();
  const stem = path.basename(base, path.extname(base)) || "receipt";
  const preferred = `${String(index + 1).padStart(2, "0")}-${stem}${extension || ".png"}`;
  if (!existsSync(path.join(receiptsDir, preferred))) return preferred;

  const ext = path.extname(preferred);
  const name = preferred.slice(0, -ext.length);
  let copy = 2;
  while (existsSync(path.join(receiptsDir, `${name}-${copy}${ext}`))) copy += 1;
  return `${name}-${copy}${ext}`;
}

const app = express();
app.use(cors());
app.use("/receipts", express.static(receiptsDir));

app.get("/api/report", (_req, res) => {
  res.json(loadReport(db));
});

function uploadError(error: unknown, res: express.Response, kind: "receipts" | "statement"): void {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    const message = kind === "receipts"
      ? "Each receipt photo must be 50 KB or smaller."
      : "The statement CSV must be 1 MB or smaller.";
    res.status(400).json({ error: message });
    return;
  }
  if (error instanceof multer.MulterError && (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")) {
    const message = kind === "receipts"
      ? `You can upload at most ${maxReceipts} receipt photos at once.`
      : "Choose one statement CSV.";
    res.status(400).json({ error: message });
    return;
  }
  const message = error instanceof Error ? error.message : "Upload failed.";
  res.status(400).json({ error: message });
}

app.post("/api/clear", (_req, res) => {
  if (running) {
    res.status(409).json({ error: "A reconciliation is already running." });
    return;
  }

  try {
    clearTables(db);
    rmSync(receiptsDir, { recursive: true, force: true });
    mkdirSync(receiptsDir, { recursive: true });
    res.json(loadReport(db));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not clear the tables.";
    console.error(error);
    res.status(500).json({ error: message });
  }
});

app.post(
  "/api/receipts",
  (req, res, next) => {
    receiptUpload.array("receipts", maxReceipts)(req, res, (error: unknown) => {
      if (error) {
        uploadError(error, res, "receipts");
        return;
      }
      next();
    });
  },
  async (req, res) => {
    if (running) {
      res.status(409).json({ error: "A save or reconciliation is already running." });
      return;
    }

    const receiptFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (receiptFiles.length === 0) {
      res.status(400).json({ error: "Choose at least one receipt photo." });
      return;
    }
    if (countReceipts(db) + receiptFiles.length > maxReceipts) {
      res.status(400).json({ error: `You can store at most ${maxReceipts} receipt photos.` });
      return;
    }

    const oversized = receiptFiles.find((file) => file.size > maxImageBytes);
    if (oversized) {
      res.status(400).json({ error: `${oversized.originalname} is larger than 50 KB.` });
      return;
    }

    const badReceipt = receiptFiles.find((file) => !imageExtensions.has(path.extname(file.originalname).toLowerCase()));
    if (badReceipt) {
      res.status(400).json({ error: `${badReceipt.originalname} is not an image.` });
      return;
    }

    running = true;
    try {
      const saved = receiptFiles.map((file, index) => {
        const fileName = safeFileName(file.originalname, index);
        const filePath = path.join(receiptsDir, fileName);
        writeFileSync(filePath, file.buffer);
        return { fileName, filePath };
      });
      const fresh = await readReceiptImages(saved);
      insertReceipts(db, fresh);
      res.json(loadReport(db));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the receipts.";
      console.error(error);
      res.status(500).json({ error: message });
    } finally {
      running = false;
    }
  },
);

app.post(
  "/api/statement",
  (req, res, next) => {
    statementUpload.single("statement")(req, res, (error: unknown) => {
      if (error) {
        uploadError(error, res, "statement");
        return;
      }
      next();
    });
  },
  (req, res) => {
    if (running) {
      res.status(409).json({ error: "A save or reconciliation is already running." });
      return;
    }

    const statementFile = req.file;
    if (!statementFile) {
      res.status(400).json({ error: "Choose a statement CSV." });
      return;
    }
    if (path.extname(statementFile.originalname).toLowerCase() !== ".csv") {
      res.status(400).json({ error: "The statement must be a CSV file." });
      return;
    }

    running = true;
    try {
      const statement = parseStatementCsv(statementFile.buffer.toString("utf8"));
      replaceStatementLines(db, statement);
      res.json(loadReport(db));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the statement.";
      console.error(error);
      res.status(500).json({ error: message });
    } finally {
      running = false;
    }
  },
);

app.post("/api/reconcile", (_req, res) => {
  if (running) {
    res.status(409).json({ error: "A save or reconciliation is already running." });
    return;
  }

  const receipts = loadReceiptDrafts(db);
  const statement = loadStatementDrafts(db);
  if (receipts.length === 0) {
    res.status(400).json({ error: "Save receipt photos before reconciling." });
    return;
  }
  if (statement.length === 0) {
    res.status(400).json({ error: "Save the statement CSV before reconciling." });
    return;
  }

  running = true;
  try {
    replaceMatches(db, reconcile(receipts, statement));
    res.json(loadReport(db));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reconciliation failed.";
    console.error(error);
    res.status(500).json({ error: message });
  } finally {
    running = false;
  }
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
