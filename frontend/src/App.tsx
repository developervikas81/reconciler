import { useEffect, useState, type ChangeEvent } from "react";
import type { Report, ReportRow } from "./types";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const apiBase = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}

function formatAed(fils: number | null): string {
  if (fils == null) return "—";
  const whole = Math.floor(fils / 100).toLocaleString("en-US");
  const frac = String(fils % 100).padStart(2, "0");
  return `${whole}.${frac} AED`;
}

function statusLabel(row: ReportRow): string {
  if (row.status === "matched") return "Matched";
  if (row.status === "duplicate") return "Duplicate receipt";
  if (row.status === "mismatch") return "Amount mismatch";
  if (row.receipt && !row.statementLine) return "No statement line";
  return "No receipt";
}

export function App() {
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [statementFile, setStatementFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(apiUrl("/api/report"))
      .then((response) => response.json())
      .then((nextReport: Report) => setReport(nextReport))
      .catch(() => {
        setError("The API is not running. Start it with npm run dev from the reconciler folder.");
      });
  }, []);

  function onReceipts(event: ChangeEvent<HTMLInputElement>) {
    setReceiptFiles(Array.from(event.target.files ?? []));
  }

  function onStatement(event: ChangeEvent<HTMLInputElement>) {
    setStatementFile(event.target.files?.[0] ?? null);
  }

  const hasSavedReceipts = (report?.summary.receiptCount ?? 0) > 0;
  const hasSavedStatement = (report?.summary.statementCount ?? 0) > 0;
  const canReconcile = (receiptFiles.length > 0 || hasSavedReceipts) && (statementFile !== null || hasSavedStatement) && (receiptFiles.length > 0 || statementFile !== null);

  async function reconcile() {
    if (!canReconcile) return;
    setRunning(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of receiptFiles) form.append("receipts", file);
      if (statementFile) form.append("statement", statementFile);
      const response = await fetch(apiUrl("/api/reconcile"), { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Reconciliation failed.");
      setReport(body as Report);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reconciliation failed.");
    } finally {
      setRunning(false);
    }
  }

  async function clearTables() {
    if (!window.confirm("Clear receipts, statement lines, and matches? This cannot be undone.")) return;
    setClearing(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/clear"), { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not clear the tables.");
      setReport(body as Report);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not clear the tables.");
    } finally {
      setClearing(false);
    }
  }

  const rows = report?.rows ?? [];
  const matched = rows.filter((row) => row.status === "matched");
  const flagged = rows.filter((row) => row.status === "mismatch" || row.status === "duplicate");
  const unmatchedReceipts = rows.filter((row) => row.status === "missing" && row.receipt && !row.statementLine);
  const unmatchedLines = rows.filter((row) => row.status === "missing" && row.statementLine && !row.receipt);
  const unmatchedCount = (report?.summary.missingReceiptSide ?? 0) + (report?.summary.missingStatementSide ?? 0);
  const flaggedCount = (report?.summary.duplicate ?? 0) + (report?.summary.mismatch ?? 0);

  return (
    <main className="app">
      <header className="top">
        <div>
          <h1>Receipt Reconciler</h1>
          <p className="lede">
            Upload receipt photos and the card statement. Photos you already saved stay, so a later run can add only the ones you left out.
          </p>
        </div>
      </header>

      <section className="uploads">
        <label className="picker">
          <span className="kicker">Receipt photos</span>
          <strong>Choose images</strong>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            disabled={running || clearing}
            onChange={onReceipts}
          />
          <p className="meta">
            {receiptFiles.length === 0
              ? "Saved photos stay. Choose only the ones you still need to add."
              : `${receiptFiles.length} new photos selected.`}
          </p>
          {receiptFiles.length > 0 ? (
            <ul className="file-list">
              {receiptFiles.map((file) => <li key={file.name}>{file.name}</li>)}
            </ul>
          ) : null}
        </label>
        <label className="picker">
          <span className="kicker">Card statement</span>
          <strong>Choose a CSV</strong>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={running || clearing}
            onChange={onStatement}
          />
          <p className="meta">{statementFile ? statementFile.name : "Use the saved statement, or choose a new CSV."}</p>
        </label>
      </section>

      <div className="actions">
        <div className="action-row">
          <button
            type="button"
            onClick={() => void reconcile()}
            disabled={running || clearing || !canReconcile}
          >
            {running ? "Reading receipts…" : "Reconcile"}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void clearTables()}
            disabled={running || clearing || !report?.hasRun}
          >
            {clearing ? "Clearing…" : "Clear tables"}
          </button>
        </div>
        <p className="meta">Only the new photos are read. Use Clear tables to start over.</p>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {report?.hasRun ? (
        <>
          <section className="counts">
            <div className="count"><span>Matched</span><strong>{report.summary.matched}</strong></div>
            <div className="count"><span>Unmatched</span><strong>{unmatchedCount}</strong></div>
            <div className="count"><span>Flagged</span><strong>{flaggedCount}</strong></div>
          </section>

          <Section title={`Matched · ${matched.length}`} rows={matched} />
          <Section title={`Unmatched · ${unmatchedCount}`} rows={[...unmatchedReceipts, ...unmatchedLines]} />
          <Section title={`Flagged · ${flaggedCount}`} rows={flagged} />
        </>
      ) : (
        <section className="empty">
          <p>
            {running
              ? "Extracting merchant, amount, and date from each photo, then matching both ways. The first run takes about a minute."
              : "Add the receipt photos and the statement CSV, then reconcile. The report lists matched pairs, both unmatched sides, duplicates, and amount mismatches."}
          </p>
        </section>
      )}
    </main>
  );
}

function Section({ title, rows }: { title: string; rows: ReportRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="section">
      <h2>{title}</h2>
      <div className="stack">
        {rows.map((row) => <PairCard key={row.id} row={row} />)}
      </div>
    </section>
  );
}

function PairCard({ row }: { row: ReportRow }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const receiptAmount = row.receipt?.amountFils ?? null;
  const statementAmount = row.statementLine?.amountFils ?? null;
  const imageSrc = row.receipt ? apiUrl(`/receipts/${encodeURIComponent(row.receipt.fileName)}`) : "";

  return (
    <article className={`card ${row.status}`}>
      {row.receipt ? (
        <div className="thumb-wrap">
          <img className="thumb" src={imageSrc} alt="" />
          <button type="button" className="preview" aria-label="View receipt" onClick={() => setPreviewOpen(true)}>
            <EyeIcon />
          </button>
        </div>
      ) : (
        <div className="placeholder" />
      )}
      <div className="side">
        <div className="kicker">Receipt</div>
        <h3>{row.receipt?.merchant ?? "No receipt"}</h3>
        {row.receipt ? (
          <p className="figures">
            {formatDate(row.receipt.txnDate)}
            {row.receipt.txnTime ? ` · ${row.receipt.txnTime}` : ""} · {formatAed(receiptAmount)}
            {row.receipt.cardLast4 ? ` · ****${row.receipt.cardLast4}` : ""}
          </p>
        ) : (
          <p className="figures">Nothing was submitted for this charge.</p>
        )}
      </div>
      <div className="side">
        <div className="kicker">Statement</div>
        <h3>{row.statementLine?.description ?? "No statement line"}</h3>
        {row.statementLine ? (
          <p className="figures">
            {formatDate(row.statementLine.txnDate)} · {formatAed(statementAmount)} · {row.statementLine.ref}
          </p>
        ) : (
          <p className="figures">No card charge matched this receipt.</p>
        )}
        <span className="pill">{statusLabel(row)}</span>
        <p className="reason">{row.reason}</p>
        {row.receipt?.rawText ? (
          <details>
            <summary>Text read from the photo</summary>
            <pre>{row.receipt.rawText}</pre>
          </details>
        ) : null}
      </div>
      {previewOpen && row.receipt ? (
        <ReceiptPreview
          src={imageSrc}
          title={row.receipt.merchant ?? row.receipt.fileName}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </article>
  );
}

function ReceiptPreview({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <button type="button" className="lightbox-close" aria-label="Close receipt" onClick={onClose}>
        Close
      </button>
      <img src={src} alt={title} onClick={(event) => event.stopPropagation()} />
    </div>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
