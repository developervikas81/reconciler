import { useEffect, useState, type ChangeEvent } from "react";
import type { Report, ReportRow } from "./types";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const maxReceipts = 100;
const maxImageBytes = 50 * 1024;
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
  const [receiptInputKey, setReceiptInputKey] = useState(0);
  const [statementInputKey, setStatementInputKey] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [savingReceipts, setSavingReceipts] = useState(false);
  const [savingStatement, setSavingStatement] = useState(false);
  const [running, setRunning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = savingReceipts || savingStatement || running || clearing;

  useEffect(() => {
    void fetch(apiUrl("/api/report"))
      .then((response) => response.json())
      .then((nextReport: Report) => setReport(nextReport))
      .catch(() => {
        setError("The API is not running. Start it with npm run dev from the reconciler folder.");
      });
  }, []);

  function onReceipts(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const oversized = files.find((file) => file.size > maxImageBytes);
    if (files.length > maxReceipts) {
      setReceiptFiles([]);
      setError(`You can upload at most ${maxReceipts} receipt photos at once.`);
      event.target.value = "";
      return;
    }
    if (oversized) {
      setReceiptFiles([]);
      setError(`${oversized.name} is larger than 50 KB.`);
      event.target.value = "";
      return;
    }
    setError(null);
    setReceiptFiles(files);
  }

  function onStatement(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setStatementFile(event.target.files?.[0] ?? null);
  }

  const hasSavedReceipts = (report?.summary.receiptCount ?? 0) > 0;
  const hasSavedStatement = (report?.summary.statementCount ?? 0) > 0;

  async function saveReceipts() {
    if (receiptFiles.length === 0) return;
    setSavingReceipts(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of receiptFiles) form.append("receipts", file);
      const response = await fetch(apiUrl("/api/receipts"), { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save the receipts.");
      setReport(body as Report);
      setReceiptFiles([]);
      setReceiptInputKey((key) => key + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the receipts.");
    } finally {
      setSavingReceipts(false);
    }
  }

  async function saveStatement() {
    if (!statementFile) return;
    setSavingStatement(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("statement", statementFile);
      const response = await fetch(apiUrl("/api/statement"), { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save the statement.");
      setReport(body as Report);
      setStatementFile(null);
      setStatementInputKey((key) => key + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the statement.");
    } finally {
      setSavingStatement(false);
    }
  }

  async function reconcile() {
    if (!hasSavedReceipts || !hasSavedStatement) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/reconcile"), { method: "POST" });
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
            Save receipt photos and the card statement first. Reconcile uses only what is already stored.
          </p>
        </div>
      </header>

      <section className="uploads">
        <label className="picker">
          <span className="kicker">Receipt photos</span>
          <strong>Choose images</strong>
          <input
            key={receiptInputKey}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            disabled={busy}
            onChange={onReceipts}
          />
          <p className="meta">
            {receiptFiles.length === 0
              ? "Up to 100 photos, 50 KB each. Saved photos stay until you clear them."
              : `${receiptFiles.length} photos selected.`}
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
            key={statementInputKey}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={onStatement}
          />
          <p className="meta">{statementFile ? statementFile.name : "Choose a CSV. Saving it replaces the stored statement."}</p>
        </label>
      </section>

      <div className="actions">
        <div className="action-row">
          <button
            type="button"
            onClick={() => void saveReceipts()}
            disabled={busy || receiptFiles.length === 0}
          >
            {savingReceipts ? "Reading receipts…" : "Save receipts"}
          </button>
          <button
            type="button"
            onClick={() => void saveStatement()}
            disabled={busy || !statementFile}
          >
            {savingStatement ? "Saving statement…" : "Save statement"}
          </button>
          <button
            type="button"
            onClick={() => void reconcile()}
            disabled={busy || !hasSavedReceipts || !hasSavedStatement}
          >
            {running ? "Reconciling…" : "Reconcile"}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void clearTables()}
            disabled={busy || !report?.hasRun}
          >
            {clearing ? "Clearing…" : "Clear tables"}
          </button>
        </div>
        <p className="meta">
          {report
            ? `${report.summary.receiptCount} receipts saved · ${report.summary.statementCount} statement lines saved.`
            : "Save both sides, then reconcile."}
        </p>
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
            {savingReceipts
              ? "Reading merchant, amount, and date from each photo, then storing the receipts."
              : "Save the receipt photos and the statement CSV. Reconcile after both are stored. The report lists matched pairs, both unmatched sides, duplicates, and amount mismatches."}
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
