import cors from "cors";
import express from "express";
import multer from "multer";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseStatementCsv } from "./csv.js";
import { addReceiptsAndRematch, clearTables, loadReceiptDrafts, loadReport, loadStatementDrafts, openDatabase } from "./db.js";
import { readReceiptImages } from "./extract.js";
import { reconcile } from "./reconcile.js";

const uploadRoot = path.resolve(process.cwd(), "data", "uploads");
const receiptsDir = path.join(uploadRoot, "receipts");
const port = Number(process.env.PORT ?? 3001);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const db = openDatabase();
let running = false;

mkdirSync(receiptsDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 101 },
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
  "/api/reconcile",
  (req, res, next) => {
    upload.fields([
      { name: "receipts", maxCount: 100 },
      { name: "statement", maxCount: 1 },
    ])(req, res, (error: unknown) => {
      if (error) {
        const message = error instanceof Error ? error.message : "Upload failed.";
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    if (running) {
      res.status(409).json({ error: "A reconciliation is already running." });
      return;
    }

    const uploaded = req.files as { receipts?: Express.Multer.File[]; statement?: Express.Multer.File[] } | undefined;
    const receiptFiles = uploaded?.receipts ?? [];
    const statementFile = uploaded?.statement?.[0];

    if (receiptFiles.length === 0 && loadReceiptDrafts(db).length === 0) {
      res.status(400).json({ error: "Add at least one receipt photo." });
      return;
    }

    if (!statementFile && loadStatementDrafts(db).length === 0) {
      res.status(400).json({ error: "Add the statement CSV." });
      return;
    }

    if (statementFile && path.extname(statementFile.originalname).toLowerCase() !== ".csv") {
      res.status(400).json({ error: "The statement must be a CSV file." });
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

      const fresh = saved.length > 0 ? await readReceiptImages(saved) : [];
      const statement = statementFile ? parseStatementCsv(statementFile.buffer.toString("utf8")) : loadStatementDrafts(db);
      const receipts = [...loadReceiptDrafts(db), ...fresh];
      const matches = reconcile(receipts, statement);
      addReceiptsAndRematch(db, fresh, statementFile ? statement : null, matches);
      res.json(loadReport(db));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reconciliation failed.";
      console.error(error);
      res.status(500).json({ error: message });
    } finally {
      running = false;
    }
  },
);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
