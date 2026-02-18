import { useState, useEffect, useRef } from 'react';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ── Config from env vars ──────────────────────────────────────────────────────
const S3_BUCKET    = import.meta.env.VITE_S3_BUCKET;
const REGION       = import.meta.env.VITE_AWS_REGION;
const API_URL      = import.meta.env.VITE_API_URL;
const CHAT_API_URL = import.meta.env.VITE_CHAT_API_URL;
const S3_ACCESS_KEY = import.meta.env.VITE_S3_ACCESS_KEY;
const S3_SECRET_KEY = import.meta.env.VITE_S3_SECRET_KEY;

const s3 = new S3Client({
  region: REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
});

const QUICK_SUGGESTIONS = [
  "Summarize this month's spending",
  "What are my top merchants?",
  "Show my most expensive item",
  "Compare last two months",
];

// ── Formatters ────────────────────────────────────────────────────────────────
const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d) ? dateStr : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatDateTime = (isoStr) => {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return isNaN(d) ? null : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const formatAmount = (val) => {
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ── Markdown renderer for AI chat bubbles ────────────────────────────────────
// Handles: **bold**, *italic*, `code`, ## headings, * /- /1. lists, line breaks
// No external dependencies — pure React nodes

const parseInline = (text) => {
  // Process inline: **bold**, *italic*, `code`
  const parts = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) parts.push(<strong key={m.index}>{m[2]}</strong>);
    else if (m[3] !== undefined) parts.push(<em key={m.index}>{m[3]}</em>);
    else if (m[4] !== undefined) parts.push(<code key={m.index} className="md-inline-code">{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
};

const MarkdownMessage = ({ text }) => {
  if (!text) return null;

  // Split into top-level blocks by blank lines
  const rawBlocks = text.split(/\n{2,}/);
  const nodes = [];

  rawBlocks.forEach((block, bi) => {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return;

    // ── Heading: ## or ###
    if (/^#{1,3}\s/.test(lines[0])) {
      const lvl = (lines[0].match(/^(#+)/)?.[1].length) || 2;
      const headText = lines[0].replace(/^#+\s+/, '');
      const Tag = lvl === 1 ? 'h2' : lvl === 2 ? 'h3' : 'h4';
      nodes.push(<Tag key={bi} className={`md-h${lvl}`}>{parseInline(headText)}</Tag>);
      // Any remaining lines become a paragraph
      if (lines.length > 1) {
        nodes.push(
          <p key={`${bi}-p`} className="md-p">
            {lines.slice(1).map((l, li) => (<span key={li}>{parseInline(l)}{li < lines.length - 2 ? <br/> : null}</span>))}
          </p>
        );
      }
      return;
    }

    // ── Unordered list: lines starting with * or -
    if (lines.every(l => /^[\*\-]\s/.test(l.trim()))) {
      nodes.push(
        <ul key={bi} className="md-ul">
          {lines.map((l, li) => (
            <li key={li} className="md-li">{parseInline(l.trim().replace(/^[\*\-]\s+/, ''))}</li>
          ))}
        </ul>
      );
      return;
    }

    // ── Ordered list: lines starting with 1. 2. etc.
    if (lines.every(l => /^\d+\.\s/.test(l.trim()))) {
      nodes.push(
        <ol key={bi} className="md-ol">
          {lines.map((l, li) => (
            <li key={li} className="md-li">{parseInline(l.trim().replace(/^\d+\.\s+/, ''))}</li>
          ))}
        </ol>
      );
      return;
    }

    // ── Mixed block: may contain some list items and some plain lines
    // Split into sub-runs of list vs non-list
    let runType = null;
    let run = [];
    const flushRun = (key) => {
      if (!run.length) return;
      if (runType === 'ul') {
        nodes.push(<ul key={key} className="md-ul">{run.map((l, i) => <li key={i} className="md-li">{parseInline(l.replace(/^[\*\-]\s+/, ''))}</li>)}</ul>);
      } else if (runType === 'ol') {
        nodes.push(<ol key={key} className="md-ol">{run.map((l, i) => <li key={i} className="md-li">{parseInline(l.replace(/^\d+\.\s+/, ''))}</li>)}</ol>);
      } else {
        nodes.push(
          <p key={key} className="md-p">
            {run.map((l, i) => (<span key={i}>{parseInline(l)}{i < run.length - 1 ? <br/> : null}</span>))}
          </p>
        );
      }
      run = [];
    };

    lines.forEach((line, li) => {
      const t = line.trim();
      const type = /^[\*\-]\s/.test(t) ? 'ul' : /^\d+\.\s/.test(t) ? 'ol' : 'p';
      if (type !== runType) { flushRun(`${bi}-${li}`); runType = type; }
      run.push(type === 'p' ? line : t);
    });
    flushRun(`${bi}-end`);
  });

  return <div className="md-body">{nodes}</div>;
};

// ── Deterministic merchant colour ─────────────────────────────────────────────
const MERCHANT_COLORS = [
  ['#EDE9FE', '#7C3AED'],
  ['#DBEAFE', '#1D4ED8'],
  ['#D1FAE5', '#059669'],
  ['#FEF3C7', '#B45309'],
  ['#FCE7F3', '#BE185D'],
  ['#E0F2FE', '#0369A1'],
  ['#FFF7ED', '#C2410C'],
];
const merchantColor = (name = '') => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return MERCHANT_COLORS[Math.abs(hash) % MERCHANT_COLORS.length];
};

// ─────────────────────────────────────────────────────────────────────────────
//  EXPENSE DETAIL PANEL
//  Shows: merchant header · total · processedAt · summary · itemised list
// ─────────────────────────────────────────────────────────────────────────────
function ExpenseDetailPanel({ expense, onClose }) {
  const items        = expense?.items || [];
  const computedTotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
  const [bg, fg]     = merchantColor(expense?.merchant);
  const processedAt  = formatDateTime(expense?.processedAt);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!expense) return null;

  return (
    <>
      <div className="detail-backdrop" onClick={onClose} />
      <div className="detail-panel">

        {/* Coloured merchant header */}
        <div className="detail-header" style={{ background: bg }}>
          <div className="detail-merchant-row">
            <div className="detail-merchant-avatar" style={{ background: fg }}>
              {(expense.merchant || '?')[0].toUpperCase()}
            </div>
            <div>
              <div className="detail-merchant-name" style={{ color: fg }}>{expense.merchant}</div>
              <div className="detail-merchant-date">{formatDate(expense.date)}</div>
            </div>
          </div>
          <button className="detail-close-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Total + item count */}
        <div className="detail-total-banner">
          <div>
            <div className="detail-total-label">Total Amount</div>
            <div className="detail-total-value">${formatAmount(expense.total)}</div>
          </div>
          {items.length > 0 && (
            <div className="detail-items-count-badge" style={{ background: bg, color: fg }}>
              {items.length} item{items.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>

        {/* Summary */}
        {expense.summary && (
          <div className="detail-section">
            <div className="detail-section-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Summary
            </div>
            <p className="detail-summary-text">{expense.summary}</p>
          </div>
        )}

        {/* Line items (full list from OCR Lambda) */}
        {items.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
              Line Items
            </div>

            <div className="detail-items-list">
              {items.map((item, i) => {
                const pct = computedTotal > 0 ? Math.round((parseFloat(item.price) / computedTotal) * 100) : 0;
                return (
                  <div className="detail-item-row" key={i} style={{ animationDelay: `${i * 40}ms` }}>
                    <div className="detail-item-left">
                      <div className="detail-item-index" style={{ background: bg, color: fg }}>{i + 1}</div>
                      <div className="detail-item-name">{item.name}</div>
                    </div>
                    <div className="detail-item-right">
                      <div className="detail-item-bar-wrap">
                        <div className="detail-item-bar">
                          <div className="detail-item-bar-fill" style={{ width: `${pct}%`, background: fg }} />
                        </div>
                        <span className="detail-item-pct">{pct}%</span>
                      </div>
                      <div className="detail-item-price">${formatAmount(item.price)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Subtotal / adjustments / total footer */}
            <div className="detail-items-footer">
              <div className="detail-footer-row">
                <span>Subtotal ({items.length} item{items.length !== 1 ? 's' : ''})</span>
                <span>${formatAmount(computedTotal)}</span>
              </div>
              {Math.abs(computedTotal - parseFloat(expense.total)) > 0.01 && (
                <div className="detail-footer-row muted">
                  <span>Tax / Adjustments</span>
                  <span>${formatAmount(parseFloat(expense.total) - computedTotal)}</span>
                </div>
              )}
              <div className="detail-footer-row total-row">
                <span>Total Charged</span>
                <span>${formatAmount(expense.total)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Meta: receipt ID + processedAt (new from OCR Lambda) */}
        <div className="detail-meta">
          <div className="detail-meta-row">
            <span>Receipt ID</span>
            <code>{expense.expenseId}</code>
          </div>
          {processedAt && (
            <div className="detail-meta-row">
              <span>Processed</span>
              <span className="detail-meta-ts">{processedAt}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard({ user, signOut }) {
  const [activeTab, setActiveTab]         = useState('expenses');
  const [file, setFile]                   = useState(null);
  const [uploading, setUploading]         = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [expenses, setExpenses]           = useState([]);
  const [loading, setLoading]             = useState(false);
  const [fetchError, setFetchError]       = useState(null);   // ← new: surface fetch errors
  const [dragOver, setDragOver]           = useState(false);
  const [selectedExpense, setSelectedExpense] = useState(null);

  const [messages, setMessages] = useState([{
    id: 1, role: 'ai', time: new Date(),
    text: "Hi! I'm your AI finance assistant. I have full access to all your receipts and line items. Ask me anything — totals by merchant, monthly breakdowns, specific purchases, and more.",
  }]);
  const [question, setQuestion]     = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  const chatEndRef   = useRef(null);
  const fileInputRef = useRef(null);
  const pollRef      = useRef(null);          // ← new: polling interval for post-upload refresh
  const prevCountRef = useRef(0);             // tracks expense count to detect new arrivals

  const userEmail = user?.profile?.email;
  const userName  = user?.profile?.name || userEmail?.split('@')[0] || 'User';

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Clean up polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── fetchExpenses ─────────────────────────────────────────────────────────
  // silent = true skips the loading spinner (used during background polling)
  // Returns the new expense count so the caller can detect arrivals
  const fetchExpenses = async (silent = false) => {
    if (!userEmail) return 0;
    if (!silent) { setLoading(true); setFetchError(null); }
    let count = 0;
    try {
      const res  = await fetch(`${API_URL}?userId=${encodeURIComponent(userEmail)}`);
      const data = await res.json();

      if (!res.ok) {
        // Fetch Lambda returns { error: "..." } on 400 / 500
        throw new Error(data.error || `Server returned ${res.status}`);
      }

      if (!Array.isArray(data)) {
        throw new Error('Unexpected response format from server');
      }

      // Lambda sorts server-side (newest first); keep client sort as safety net
      const sorted = data.sort((a, b) => new Date(b.date) - new Date(a.date));
      setExpenses(sorted);
      count = sorted.length;
    } catch (e) {
      console.error('fetchExpenses:', e);
      if (!silent) setFetchError(e.message);
    }
    if (!silent) setLoading(false);
    return count;
  };

  useEffect(() => { fetchExpenses(); }, [userEmail]);

  // ── handleUpload ──────────────────────────────────────────────────────────
  // Uploads directly to S3; OCR Lambda is triggered by S3 event.
  // After upload: poll every 5 s (up to 12 attempts = 60 s) to detect when
  // the OCR Lambda has written the new expense to DynamoDB.
  const handleUpload = async () => {
    if (!file || !userEmail) return;
    setUploading(true);
    setUploadSuccess(false);

    // Clear any existing poll
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    try {
      const buf = await file.arrayBuffer();
      await s3.send(new PutObjectCommand({
        Bucket:      S3_BUCKET,
        Key:         `${userEmail}/${Date.now()}-${file.name}`,
        Body:        new Uint8Array(buf),
        ContentType: file.type,
      }));

      setUploadSuccess(true);
      setFile(null);
      prevCountRef.current = expenses.length;

      // Poll every 5 s; stop when a new expense appears or after 12 attempts
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        const newCount = await fetchExpenses(true /* silent */);
        if (newCount > prevCountRef.current || attempts >= 12) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (newCount > prevCountRef.current) {
            // New expense appeared — briefly flash the table
            prevCountRef.current = newCount;
          }
        }
      }, 5000);

      // Auto-hide the success banner after 6 s
      setTimeout(() => setUploadSuccess(false), 6000);

    } catch (err) {
      alert('Upload failed: ' + err.message);
    }
    setUploading(false);
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.type.startsWith('image/') || f.type === 'application/pdf')) setFile(f);
  };

  // ── handleChat ────────────────────────────────────────────────────────────
  // Chat Lambda now returns full line-item data in its Gemini prompt,
  // and returns { error: "..." } with a user-friendly message on failures.
  const handleChat = async (text) => {
    const q = (text || question).trim();
    if (!q) return;

    setMessages(prev => [...prev, { id: Date.now(), role: 'user', text: q, time: new Date() }]);
    setQuestion('');
    setChatLoading(true);

    try {
      const res  = await fetch(CHAT_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question: q, userId: userEmail }),
      });
      const data = await res.json();

      // Lambda returns { answer } on success, { error } on failure
      const replyText = data.answer
        || (data.error ? `⚠️ ${data.error}` : "I couldn't generate an answer — please try again.");

      setMessages(prev => [...prev, {
        id:   Date.now() + 1,
        role: 'ai',
        time: new Date(),
        text: replyText,
        isError: !data.answer && !!data.error,
      }]);
    } catch (networkErr) {
      setMessages(prev => [...prev, {
        id:      Date.now() + 1,
        role:    'ai',
        time:    new Date(),
        text:    '⚠️ Network error — please check your connection and try again.',
        isError: true,
      }]);
    }
    setChatLoading(false);
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalSpend  = expenses.reduce((s, e) => s + (parseFloat(e.total) || 0), 0);
  const now         = new Date();
  const monthTotal  = expenses
    .filter(e => { const d = new Date(e.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
    .reduce((s, e) => s + (parseFloat(e.total) || 0), 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="10" fill="#4F46E5"/>
              <path d="M8 16h4l3-6 4 12 3-6h4" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="brand-name">Xpense</span>
        </div>

        <nav className="sidebar-nav">
          {[
            { id: 'expenses', label: 'Expenses',       icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg> },
            { id: 'upload',   label: 'Upload Receipt', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg> },
            { id: 'chat',     label: 'AI Assistant',   icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> },
          ].map(t => (
            <button key={t.id} className={`nav-item ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{userName[0].toUpperCase()}</div>
            <div className="user-details">
              <div className="user-name">{userName}</div>
              <div className="user-email">{userEmail}</div>
            </div>
          </div>
          <button className="signout-btn" onClick={signOut} title="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">

        {/* Header */}
        <header className="main-header">
          <div className="header-left">
            <h1 className="page-title">
              {activeTab === 'expenses' && 'Expenses'}
              {activeTab === 'upload'   && 'Upload Receipt'}
              {activeTab === 'chat'     && 'AI Assistant'}
            </h1>
            <p className="page-subtitle">
              {activeTab === 'expenses' && `${expenses.length} transaction${expenses.length !== 1 ? 's' : ''} · click any row to see details`}
              {activeTab === 'upload'   && 'Drop a receipt — AI extracts every line item automatically'}
              {activeTab === 'chat'     && 'Ask anything · full receipt history and line items available'}
            </p>
          </div>

          {activeTab === 'expenses' && (
            <div className="header-stats">
              <div className="stat-pill">
                <span className="stat-label">This Month</span>
                <span className="stat-value">${formatAmount(monthTotal)}</span>
              </div>
              <div className="stat-pill">
                <span className="stat-label">All Time</span>
                <span className="stat-value">${formatAmount(totalSpend)}</span>
              </div>
              <button className="refresh-btn" onClick={() => fetchExpenses()} title="Refresh">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
              </button>
            </div>
          )}
        </header>

        <div className="content-body">

          {/* ── EXPENSES TAB ── */}
          {activeTab === 'expenses' && (
            <div className="tab-panel fade-in">

              {/* Error state (from Fetch Lambda { error }) */}
              {fetchError && !loading && (
                <div className="fetch-error-banner">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  <span>Failed to load expenses: {fetchError}</span>
                  <button className="fetch-error-retry" onClick={() => fetchExpenses()}>Retry</button>
                </div>
              )}

              {loading ? (
                <div className="loading-state">
                  {[1,2,3,4,5].map(i => (
                    <div className="skeleton-row" key={i}>
                      <div className="sk sk-md"/><div className="sk sk-lg"/><div className="sk sk-sm"/><div className="sk sk-xl"/>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="expenses-table-wrap">
                  <table className="expenses-table">
                    <thead>
                      <tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Summary</th><th></th></tr>
                    </thead>
                    <tbody>
                      {expenses.length === 0 && !fetchError ? (
                        <tr><td colSpan="5">
                          <div className="empty-state">
                            <div className="empty-icon">🧾</div>
                            <div className="empty-title">No expenses yet</div>
                            <div className="empty-sub">Upload your first receipt to get started</div>
                            <button className="btn-primary sm" onClick={() => setActiveTab('upload')}>Upload Receipt</button>
                          </div>
                        </td></tr>
                      ) : expenses.map((expense, i) => {
                        const [bg, fg]   = merchantColor(expense.merchant);
                        const isSelected = selectedExpense?.expenseId === expense.expenseId;
                        return (
                          <tr
                            key={expense.expenseId || i}
                            className={`table-row clickable-row ${isSelected ? 'row-selected' : ''}`}
                            onClick={() => setSelectedExpense(isSelected ? null : expense)}
                          >
                            <td><span className="date-badge">{formatDate(expense.date)}</span></td>
                            <td>
                              <div className="merchant-cell">
                                <div className="merchant-avatar" style={{ background: bg, color: fg }}>
                                  {(expense.merchant || '?')[0].toUpperCase()}
                                </div>
                                <span className="merchant-name">{expense.merchant || '—'}</span>
                              </div>
                            </td>
                            <td><span className="amount-badge">${formatAmount(expense.total)}</span></td>
                            <td><span className="summary-text">{expense.summary || '—'}</span></td>
                            <td>
                              <div className={`row-chevron ${isSelected ? 'open' : ''}`}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <polyline points="9 18 15 12 9 6"/>
                                </svg>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── UPLOAD TAB ── */}
          {activeTab === 'upload' && (
            <div className="tab-panel fade-in">
              <div className="upload-panel">

                <div
                  className={`dropzone ${dragOver ? 'drag-active' : ''} ${file ? 'has-file' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => setFile(e.target.files[0])}
                  />
                  {file ? (
                    <div className="dropzone-file">
                      <div className="file-icon">{file.type === 'application/pdf' ? '📄' : '🖼️'}</div>
                      <div className="file-info">
                        <div className="file-name">{file.name}</div>
                        <div className="file-size">{(file.size / 1024).toFixed(1)} KB · {file.type.split('/')[1].toUpperCase()}</div>
                      </div>
                      <button className="file-remove" onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <div className="dropzone-empty">
                      <div className="dz-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="1.5">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                      </div>
                      <div className="dz-title">Drop your receipt here</div>
                      <div className="dz-sub">or click to browse · JPG, PNG, WEBP, PDF</div>
                    </div>
                  )}
                </div>

                {/* Upload success — shows while polling for new expense */}
                {uploadSuccess && (
                  <div className="upload-success">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <div>
                      <strong>Receipt uploaded!</strong>
                      <span className="upload-success-sub"> AI is processing it — your expenses will update automatically.</span>
                    </div>
                    <div className="upload-poll-dots"><span/><span/><span/></div>
                  </div>
                )}

                <div className="upload-actions">
                  <button className="btn-primary" onClick={handleUpload} disabled={!file || uploading}>
                    {uploading ? (
                      <><div className="btn-spinner"/>Uploading…</>
                    ) : (
                      <>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                        Upload & Scan Receipt
                      </>
                    )}
                  </button>
                </div>

                <div className="upload-hints">
                  <div className="hint-card">
                    <span>🤖</span>
                    <p>AI extracts every line item, merchant, date, and total. The more readable your receipt, the better.</p>
                  </div>
                  <div className="hint-card">
                    <span>📧</span>
                    <p>A confirmation email with a full itemised breakdown is sent to <strong>{userEmail}</strong> after processing.</p>
                  </div>
                  <div className="hint-card">
                    <span>🔁</span>
                    <p>Duplicate uploads are detected automatically — re-uploading the same file won't create a duplicate entry.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── CHAT TAB ── */}
          {activeTab === 'chat' && (
            <div className="tab-panel chat-panel fade-in">
              <div className="chat-messages">
                {messages.map((msg) => (
                  <div key={msg.id} className={`chat-message ${msg.role}`}>
                    {msg.role === 'ai' && (
                      <div className="chat-avatar ai-avatar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                          <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                          <circle cx="9" cy="14" r="1" fill="white"/><circle cx="15" cy="14" r="1" fill="white"/>
                        </svg>
                      </div>
                    )}
                    <div className="chat-bubble-wrap">
                      {/* Error messages get a distinct style */}
                      <div className={`chat-bubble ${msg.isError ? 'chat-bubble-error' : ''}`}>
                        {msg.role === 'ai' && !msg.isError
                          ? <MarkdownMessage text={msg.text} />
                          : msg.text}
                      </div>
                      <div className="chat-time">
                        {msg.time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                    {msg.role === 'user' && (
                      <div className="chat-avatar user-avatar">{userName[0].toUpperCase()}</div>
                    )}
                  </div>
                ))}

                {/* Typing indicator */}
                {chatLoading && (
                  <div className="chat-message ai">
                    <div className="chat-avatar ai-avatar">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                        <circle cx="9" cy="14" r="1" fill="white"/><circle cx="15" cy="14" r="1" fill="white"/>
                      </svg>
                    </div>
                    <div className="chat-bubble-wrap">
                      <div className="chat-bubble typing-bubble"><span/><span/><span/></div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Quick suggestions (only on first open) */}
              {messages.length <= 1 && (
                <div className="chat-suggestions">
                  {QUICK_SUGGESTIONS.map(s => (
                    <button key={s} className="suggestion-chip" onClick={() => handleChat(s)}>{s}</button>
                  ))}
                </div>
              )}

              <div className="chat-input-bar">
                <input
                  type="text"
                  className="chat-input"
                  placeholder="Ask about your expenses…"
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleChat()}
                  disabled={chatLoading}
                />
                <button
                  className={`chat-send-btn ${question.trim() ? 'active' : ''}`}
                  onClick={() => handleChat()}
                  disabled={!question.trim() || chatLoading}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* ── Detail Panel ── */}
      {selectedExpense && (
        <ExpenseDetailPanel expense={selectedExpense} onClose={() => setSelectedExpense(null)} />
      )}
    </div>
  );
}