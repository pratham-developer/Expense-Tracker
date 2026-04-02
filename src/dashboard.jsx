// dashboard.jsx — COMPLETE FILE
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { S3Client, PutObjectCommand }                        from "@aws-sdk/client-s3";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
}                                                            from 'recharts';
import jsPDF     from 'jspdf';
import autoTable from 'jspdf-autotable';

// ── Config ────────────────────────────────────────────────────────────────────
const S3_BUCKET     = import.meta.env.VITE_S3_BUCKET;
const REGION        = import.meta.env.VITE_AWS_REGION;
const API_URL       = import.meta.env.VITE_API_URL;
const CHAT_API_URL  = import.meta.env.VITE_CHAT_API_URL;
const S3_ACCESS_KEY = import.meta.env.VITE_S3_ACCESS_KEY;
const S3_SECRET_KEY = import.meta.env.VITE_S3_SECRET_KEY;

const s3 = new S3Client({
  region:      REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
});

const QUICK_SUGGESTIONS = [
  "Summarize this month's spending",
  "What are my top merchants?",
  "Show my most expensive item",
  "Compare last two months",
  "Which category do I spend most on?",
];

const CHART_COLORS = [
  '#4F46E5','#818CF8','#34D399','#FBBF24',
  '#F87171','#60A5FA','#A78BFA','#F472B6','#94A3B8',
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

// ── Markdown renderer ─────────────────────────────────────────────────────────
const parseInline = (text) => {
  const parts = [];
  const re    = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if      (m[2] !== undefined) parts.push(<strong key={m.index}>{m[2]}</strong>);
    else if (m[3] !== undefined) parts.push(<em     key={m.index}>{m[3]}</em>);
    else if (m[4] !== undefined) parts.push(<code   key={m.index} className="md-inline-code">{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
};

const MarkdownMessage = ({ text }) => {
  if (!text) return null;
  const rawBlocks = text.split(/\n{2,}/);
  const nodes = [];
  rawBlocks.forEach((block, bi) => {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return;
    if (/^#{1,3}\s/.test(lines[0])) {
      const lvl     = (lines[0].match(/^(#+)/)?.[1].length) || 2;
      const headText = lines[0].replace(/^#+\s+/, '');
      const Tag      = lvl === 1 ? 'h2' : lvl === 2 ? 'h3' : 'h4';
      nodes.push(<Tag key={bi} className={`md-h${lvl}`}>{parseInline(headText)}</Tag>);
      if (lines.length > 1)
        nodes.push(<p key={`${bi}-p`} className="md-p">{lines.slice(1).map((l, li) => <span key={li}>{parseInline(l)}{li < lines.length - 2 ? <br/> : null}</span>)}</p>);
      return;
    }
    if (lines.every(l => /^[\*\-]\s/.test(l.trim()))) {
      nodes.push(<ul key={bi} className="md-ul">{lines.map((l, li) => <li key={li} className="md-li">{parseInline(l.trim().replace(/^[\*\-]\s+/, ''))}</li>)}</ul>);
      return;
    }
    if (lines.every(l => /^\d+\.\s/.test(l.trim()))) {
      nodes.push(<ol key={bi} className="md-ol">{lines.map((l, li) => <li key={li} className="md-li">{parseInline(l.trim().replace(/^\d+\.\s+/, ''))}</li>)}</ol>);
      return;
    }
    let runType = null, run = [];
    const flushRun = (key) => {
      if (!run.length) return;
      if      (runType === 'ul') nodes.push(<ul key={key} className="md-ul">{run.map((l, i) => <li key={i} className="md-li">{parseInline(l.replace(/^[\*\-]\s+/, ''))}</li>)}</ul>);
      else if (runType === 'ol') nodes.push(<ol key={key} className="md-ol">{run.map((l, i) => <li key={i} className="md-li">{parseInline(l.replace(/^\d+\.\s+/, ''))}</li>)}</ol>);
      else nodes.push(<p key={key} className="md-p">{run.map((l, i) => <span key={i}>{parseInline(l)}{i < run.length - 1 ? <br/> : null}</span>)}</p>);
      run = [];
    };
    lines.forEach((line, li) => {
      const t    = line.trim();
      const type = /^[\*\-]\s/.test(t) ? 'ul' : /^\d+\.\s/.test(t) ? 'ol' : 'p';
      if (type !== runType) { flushRun(`${bi}-${li}`); runType = type; }
      run.push(type === 'p' ? line : t);
    });
    flushRun(`${bi}-end`);
  });
  return <div className="md-body">{nodes}</div>;
};

// ── Merchant colour ───────────────────────────────────────────────────────────
const MERCHANT_COLORS = [
  ['#EDE9FE','#7C3AED'],['#DBEAFE','#1D4ED8'],['#D1FAE5','#059669'],
  ['#FEF3C7','#B45309'],['#FCE7F3','#BE185D'],['#E0F2FE','#0369A1'],
  ['#FFF7ED','#C2410C'],
];
const merchantColor = (name = '') => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return MERCHANT_COLORS[Math.abs(hash) % MERCHANT_COLORS.length];
};

// ── Session label formatter ───────────────────────────────────────────────────
const formatSessionLabel = (sid) => {
  const part = sid.split('#').slice(1).join('#');
  if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
    return new Date(part + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }
  const ts = parseInt(part, 10);
  if (!isNaN(ts)) {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
  return part;
};

// ── Expense Detail Panel ──────────────────────────────────────────────────────
function ExpenseDetailPanel({ expense, onClose }) {
  const items         = expense?.items || [];
  const computedTotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
  const [bg, fg]      = merchantColor(expense?.merchant);
  const processedAt   = formatDateTime(expense?.processedAt);

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
        <div className="detail-header" style={{ background: bg }}>
          <div className="detail-merchant-row">
            <div className="detail-merchant-avatar" style={{ background: fg }}>
              {(expense.merchant || '?')[0].toUpperCase()}
            </div>
            <div>
              <div className="detail-merchant-name" style={{ color: fg }}>{expense.merchant}</div>
              <div className="detail-merchant-date">{formatDate(expense.date)}</div>
              {expense.category && (
                <div className="detail-category-badge" style={{ background: fg, color: '#fff' }}>
                  {expense.category}
                </div>
              )}
            </div>
          </div>
          <button className="detail-close-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

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

        {items.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
                <line x1="3" y1="18" x2="3.01" y2="18"/>
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
                          <div className="detail-item-bar-fill" style={{ width: `${pct}%`, background: fg }}/>
                        </div>
                        <span className="detail-item-pct">{pct}%</span>
                      </div>
                      <div className="detail-item-price">${formatAmount(item.price)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
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

        <div className="detail-meta">
          <div className="detail-meta-row"><span>Receipt ID</span><code>{expense.expenseId}</code></div>
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

// ── AI Robot Icon ─────────────────────────────────────────────────────────────
const AIIcon = ({ size = 14, color = 'white' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
    <circle cx="9" cy="14" r="1" fill={color} stroke="none"/>
    <circle cx="15" cy="14" r="1" fill={color} stroke="none"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard({ user, signOut }) {
  const [activeTab, setActiveTab]             = useState('expenses');
  const [file, setFile]                       = useState(null);
  const [uploading, setUploading]             = useState(false);
  const [uploadSuccess, setUploadSuccess]     = useState(false);
  const [expenses, setExpenses]               = useState([]);
  const [loading, setLoading]                 = useState(false);
  const [fetchError, setFetchError]           = useState(null);
  const [dragOver, setDragOver]               = useState(false);
  const [selectedExpense, setSelectedExpense] = useState(null);

  // Chat state
  const [messages, setMessages] = useState([{
    id: 1, role: 'ai', time: new Date(),
    text: "Hi! I'm your AI finance assistant with memory — I remember our conversation as you ask follow-up questions. I have full access to all your receipts and line items. Ask me anything!",
  }]);
  const [question, setQuestion]           = useState('');
  const [chatLoading, setChatLoading]     = useState(false);
  const [sessionId, setSessionId]         = useState(null);
  const [pastSessions, setPastSessions]   = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Voice
  const [isListening, setIsListening] = useState(false);
  const recognitionRef                = useRef(null);

  // Analytics / Forecast
  const [forecastText, setForecastText]       = useState('');
  const [forecastLoading, setForecastLoading] = useState(false);

  const chatEndRef   = useRef(null);
  const fileInputRef = useRef(null);
  const pollRef      = useRef(null);
  const prevCountRef = useRef(0);

  const userEmail = user?.profile?.email;
  const userName  = user?.profile?.name || userEmail?.split('@')[0] || 'User';

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Fetch expenses ─────────────────────────────────────────────────────────
  const fetchExpenses = useCallback(async (silent = false) => {
    if (!userEmail) return 0;
    if (!silent) { setLoading(true); setFetchError(null); }
    let count = 0;
    try {
      const res  = await fetch(`${API_URL}?userId=${encodeURIComponent(userEmail)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      if (!Array.isArray(data)) throw new Error('Unexpected response format from server');
      const sorted = data.sort((a, b) => new Date(b.date) - new Date(a.date));
      setExpenses(sorted);
      count = sorted.length;
    } catch (e) {
      console.error('fetchExpenses:', e);
      if (!silent) setFetchError(e.message);
    }
    if (!silent) setLoading(false);
    return count;
  }, [userEmail]);

  useEffect(() => { fetchExpenses(); }, [fetchExpenses]);

  // ── Fetch sessions ─────────────────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    if (!userEmail) return;
    setSessionsLoading(true);
    try {
      const res  = await fetch(CHAT_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'listSessions', userId: userEmail }),
      });
      const data = await res.json();
      setPastSessions(data.sessions || []);
    } catch (e) { console.error('fetchSessions:', e); }
    setSessionsLoading(false);
  }, [userEmail]);

  useEffect(() => {
    if (activeTab === 'chat') fetchSessions();
  }, [activeTab, fetchSessions]);

  // ── Load a past session ────────────────────────────────────────────────────
  const loadSession = useCallback(async (sid) => {
    setSessionId(sid);
    setChatLoading(true);
    try {
      const res  = await fetch(CHAT_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'getSession', userId: userEmail, sessionId: sid }),
      });
      const data = await res.json();
      const loaded = (data.messages || []).map((m, i) => ({
        id:   i + 1,
        role: m.role,
        time: new Date(),
        text: m.text,
      }));
      setMessages(loaded.length ? loaded : [{
        id: 1, role: 'ai', time: new Date(),
        text: 'Session loaded — continue the conversation below!',
      }]);
    } catch (e) {
      console.error('loadSession:', e);
      setMessages([{
        id: 1, role: 'ai', time: new Date(),
        text: 'Could not load session. Please try again.',
      }]);
    }
    setChatLoading(false);
  }, [userEmail]);

  // ── Chart data ─────────────────────────────────────────────────────────────
  const categoryData = useMemo(() => {
    const map = {};
    for (const e of expenses) {
      const cat = e.category || 'Other';
      map[cat] = (map[cat] ?? 0) + (parseFloat(e.total) || 0);
    }
    return Object.entries(map)
      .map(([name, value]) => ({ name, value: parseFloat(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value);
  }, [expenses]);

  const monthlyData = useMemo(() => {
    const map = {};
    for (const e of expenses) {
      const month = e.date?.slice(0, 7);
      if (month) map[month] = (map[month] ?? 0) + (parseFloat(e.total) || 0);
    }
    return Object.entries(map)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([month, total]) => ({ month, total: parseFloat(total.toFixed(2)) }));
  }, [expenses]);

  const merchantData = useMemo(() => {
    const map = {};
    for (const e of expenses) {
      map[e.merchant] = (map[e.merchant] ?? 0) + (parseFloat(e.total) || 0);
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, total]) => ({ name, total: parseFloat(total.toFixed(2)) }));
  }, [expenses]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const totalSpend = expenses.reduce((s, e) => s + (parseFloat(e.total) || 0), 0);
  const now        = new Date();
  const monthTotal = expenses
    .filter(e => {
      const d = new Date(e.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, e) => s + (parseFloat(e.total) || 0), 0);

  // ── Upload ─────────────────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!file || !userEmail) return;
    setUploading(true); setUploadSuccess(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    try {
      const buf = await file.arrayBuffer();
      await s3.send(new PutObjectCommand({
        Bucket:      S3_BUCKET,
        Key:         `${userEmail}/${Date.now()}-${file.name}`,
        Body:        new Uint8Array(buf),
        ContentType: file.type,
      }));
      setUploadSuccess(true); setFile(null);
      prevCountRef.current = expenses.length;
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        const newCount = await fetchExpenses(true);
        if (newCount > prevCountRef.current || attempts >= 12) {
          clearInterval(pollRef.current); pollRef.current = null;
          if (newCount > prevCountRef.current) prevCountRef.current = newCount;
        }
      }, 5000);
      setTimeout(() => setUploadSuccess(false), 6000);
    } catch (err) { alert('Upload failed: ' + err.message); }
    setUploading(false);
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.type.startsWith('image/') || f.type === 'application/pdf')) setFile(f);
  };

  // ── Voice Input ────────────────────────────────────────────────────────────
  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Voice input isn't supported in this browser. Try Chrome."); return; }
    const recognition           = new SR();
    recognition.lang            = 'en-US';
    recognition.interimResults  = false;
    recognition.maxAlternatives = 1;
    recognition.onstart  = () => setIsListening(true);
    recognition.onend    = () => setIsListening(false);
    recognition.onerror  = () => setIsListening(false);
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setQuestion(transcript);
      handleChat(transcript);
    };
    recognitionRef.current = recognition;
    recognition.start();
  };

  const stopVoice = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
  };

  // ── Chat ───────────────────────────────────────────────────────────────────
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
        body:    JSON.stringify({
          question:  q,
          userId:    userEmail,
          sessionId: sessionId || undefined,
        }),
      });
      const data = await res.json();

      if (data.sessionId && !sessionId) {
        setSessionId(data.sessionId);
        fetchSessions();
      }

      const replyText = data.answer
        || (data.error ? `⚠️ ${data.error}` : "I couldn't generate an answer — please try again.");

      setMessages(prev => [...prev, {
        id:      Date.now() + 1,
        role:    'ai',
        time:    new Date(),
        text:    replyText,
        isError: !data.answer && !!data.error,
      }]);
    } catch {
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

  // ── New Chat ───────────────────────────────────────────────────────────────
  const handleNewChat = () => {
    const newSession = `${userEmail}#${Date.now()}`;
    setSessionId(newSession);
    setMessages([{
      id:   Date.now(),
      role: 'ai',
      time: new Date(),
      text: "New conversation started! I still have full access to all your expense data.",
    }]);
    fetchSessions();
  };

  // ── AI Forecast ────────────────────────────────────────────────────────────
  const handleForecast = async () => {
    setForecastLoading(true);
    setForecastText('');

    const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonth     = nextMonthDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const byMonth = {};
    const byCat   = {};
    for (const e of expenses) {
      const m = e.date?.slice(0, 7);
      if (m) byMonth[m] = (byMonth[m] ?? 0) + (parseFloat(e.total) || 0);
      const c = e.category || 'Other';
      byCat[c] = (byCat[c] ?? 0) + (parseFloat(e.total) || 0);
    }

    const monthEntries   = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
    const monthLines     = monthEntries.map(([m, t]) => `  ${m}: $${t.toFixed(2)}`).join('\n');
    const catLines       = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .map(([c, t]) => `  ${c}: $${t.toFixed(2)} (${totalSpend > 0 ? ((t / totalSpend) * 100).toFixed(1) : 0}%)`).join('\n');

    const numMonths    = monthEntries.length || 1;
    const avgMonthly   = (totalSpend / numMonths).toFixed(2);
    const recentMonths = monthEntries.slice(-3);
    const recentAvg    = recentMonths.length
      ? (recentMonths.reduce((s, [, v]) => s + v, 0) / recentMonths.length).toFixed(2)
      : avgMonthly;

    const prompt = `You are a financial forecasting assistant. Use the data below to project next month's spending.
You MUST produce numeric estimates — use averages and proportions from the data. Do not refuse.

HISTORICAL DATA:
- Total receipts: ${expenses.length}
- All-time total: $${totalSpend.toFixed(2)}
- Months of data: ${numMonths}
- Overall monthly average: $${avgMonthly}
- Recent 3-month average: $${recentAvg}

Monthly breakdown:
${monthLines || '  No monthly data yet'}

Category breakdown (all time):
${catLines || '  No category data yet'}

PROJECT spending for ${nextMonth}.
Method: use the recent 3-month average as the base total ($${recentAvg}), then split it by each category's historical proportion.

Respond in EXACTLY this format:

## Trend Analysis
[2-3 sentences about the spending pattern you observe in the data]

## Projected Total for ${nextMonth}
$X.XX

## Category Breakdown
- Category 1: $X.XX
- Category 2: $X.XX
[all categories, amounts must sum to the projected total]

## Key Insight
[One actionable money tip based on the data]

Use only the data above. Produce real dollar estimates.`;

    try {
      const res  = await fetch(CHAT_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userId:    userEmail,
          sessionId: `${userEmail}#forecast#${Date.now()}`,
          question:  prompt,
        }),
      });
      const data = await res.json();
      setForecastText(data.answer || 'Could not generate forecast. Try again.');
    } catch {
      setForecastText('Network error — please try again.');
    }
    setForecastLoading(false);
  };

  // ── PDF Export — Professional Report ──────────────────────────────────────
  const exportPDF = () => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210; // A4 width mm
    const generatedOn = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    // ── Colour palette ──
    const INDIGO      = [79, 70, 229];
    const INDIGO_DARK = [55, 48, 163];
    const INDIGO_LIGHT= [238, 242, 255];
    const INDIGO_MID  = [199, 210, 254];
    const WHITE       = [255, 255, 255];
    const GRAY_50     = [249, 250, 251];
    const GRAY_100    = [243, 244, 246];
    const GRAY_200    = [229, 231, 235];
    const GRAY_500    = [107, 114, 128];
    const GRAY_700    = [55, 65, 81];
    const GRAY_900    = [17, 24, 39];
    const GREEN_BG    = [220, 252, 231];
    const GREEN_FG    = [22, 163, 74];

    // ── Computed stats ──
    // ── Computed stats ──
    const byMonth = {};
    const byCat   = {};
    const byMerchant = {};
    for (const e of expenses) {
      const m = e.date?.slice(0, 7);
      if (m) byMonth[m] = (byMonth[m] ?? 0) + (parseFloat(e.total) || 0);
      const c = e.category || 'Other';
      byCat[c] = (byCat[c] ?? 0) + (parseFloat(e.total) || 0);
      byMerchant[e.merchant] = (byMerchant[e.merchant] ?? 0) + (parseFloat(e.total) || 0);
    }

    const sortedMonths   = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
    const sortedCats     = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const sortedMerchants= Object.entries(byMerchant).sort((a, b) => b[1] - a[1]);
    const numMonths      = sortedMonths.length || 1;
    const avgMonthly     = totalSpend / numMonths;
    const recentSlice    = sortedMonths.slice(-3);
    const recentAvg      = recentSlice.length
      ? recentSlice.reduce((s, [, v]) => s + v, 0) / recentSlice.length
      : avgMonthly;
    const topCat     = sortedCats[0]?.[0]   ?? '—';
    const topMerchant= sortedMerchants[0]?.[0] ?? '—';
    const avgPerReceipt = expenses.length > 0 ? totalSpend / expenses.length : 0;
    const highestMonth  = sortedMonths.reduce((a, b) => b[1] > a[1] ? b : a, ['—', 0]);
    const lowestMonth   = sortedMonths.reduce((a, b) => b[1] < a[1] ? b : a, ['—', Infinity]);

    // ── Helper: draw page header strip ──
    const drawPageHeader = (pageNum, totalPages) => {
      // Top accent bar
      doc.setFillColor(...INDIGO);
      doc.rect(0, 0, W, 14, 'F');
      // Brand name
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...WHITE);
      doc.text('XPENSE', 14, 9.5);
      // Page number right
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(`Page ${pageNum} of ${totalPages}`, W - 14, 9.5, { align: 'right' });
    };

    // ── Helper: draw page footer ──
    const drawPageFooter = () => {
      doc.setFillColor(...GRAY_100);
      doc.rect(0, 285, W, 12, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...GRAY_500);
      doc.text(`Generated ${generatedOn}  ·  Account: ${userEmail}  ·  Confidential`, W / 2, 291.5, { align: 'center' });
    };

    // ── Helper: section label ──
    const sectionLabel = (label, y) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...INDIGO);
      doc.text(label.toUpperCase(), 14, y);
      doc.setDrawColor(...INDIGO_MID);
      doc.setLineWidth(0.4);
      doc.line(14, y + 1.5, W - 14, y + 1.5);
    };

    // ─────────────────────────────────────
    //  PAGE 1 — Cover + KPIs + Summary
    // ─────────────────────────────────────
    // Hero background
    doc.setFillColor(...INDIGO);
    doc.rect(0, 0, W, 68, 'F');

    // Decorative diagonal stripe
    doc.setFillColor(...INDIGO_DARK);
    doc.triangle(W - 60, 0, W, 0, W, 68, 'F');

    // Report title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(28);
    doc.setTextColor(...WHITE);
    doc.text('Xpense Report', 14, 30);

    // Subtitle
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(199, 210, 254);
    doc.text('Personal Finance Summary', 14, 40);

    // Meta line
    doc.setFontSize(9);
    doc.setTextColor(165, 180, 252);
    doc.text(`${generatedOn}  ·  ${userEmail}`, 14, 52);

    // ── KPI cards row ──
    const kpis = [
      { label: 'All-Time Total',    value: `$${formatAmount(totalSpend)}`,         sub: `${expenses.length} receipts` },
      { label: 'This Month',        value: `$${formatAmount(monthTotal)}`,          sub: 'Current period' },
      { label: 'Monthly Average',   value: `$${formatAmount(avgMonthly)}`,          sub: `Over ${numMonths} month${numMonths !== 1 ? 's' : ''}` },
      { label: 'Avg per Receipt',   value: `$${formatAmount(avgPerReceipt)}`,       sub: 'Per transaction' },
    ];

    const cardW = (W - 28 - 9) / 4;
    const cardY = 74;
    kpis.forEach((kpi, i) => {
      const x = 14 + i * (cardW + 3);
      // Card bg
      doc.setFillColor(...WHITE);
      doc.roundedRect(x, cardY, cardW, 28, 3, 3, 'F');
      doc.setDrawColor(...INDIGO_MID);
      doc.setLineWidth(0.3);
      doc.roundedRect(x, cardY, cardW, 28, 3, 3, 'S');
      // Top accent
      doc.setFillColor(...INDIGO);
      doc.roundedRect(x, cardY, cardW, 2.5, 1, 1, 'F');
      // Label
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...GRAY_500);
      doc.text(kpi.label.toUpperCase(), x + cardW / 2, cardY + 8, { align: 'center' });
      // Value
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...INDIGO_DARK);
      doc.text(kpi.value, x + cardW / 2, cardY + 17, { align: 'center' });
      // Sub
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...GRAY_500);
      doc.text(kpi.sub, x + cardW / 2, cardY + 23.5, { align: 'center' });
    });

    // ── Secondary stats row ──
    const statsY = cardY + 34;
    const secStats = [
      { label: 'Top Category',    value: topCat },
      { label: 'Top Merchant',    value: topMerchant },
      { label: 'Highest Month',   value: highestMonth[0] !== '—' ? `${highestMonth[0]}  ($${formatAmount(highestMonth[1])})` : '—' },
      { label: 'Recent 3-Mo Avg', value: `$${formatAmount(recentAvg)}` },
    ];
    const secW = (W - 28 - 9) / 4;
    secStats.forEach((s, i) => {
      const x = 14 + i * (secW + 3);
      doc.setFillColor(...INDIGO_LIGHT);
      doc.roundedRect(x, statsY, secW, 16, 2, 2, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...INDIGO);
      doc.text(s.label.toUpperCase(), x + 5, statsY + 5.5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...INDIGO_DARK);
      doc.text(s.value, x + 5, statsY + 12.5);
    });

    // ── Category breakdown on page 1 ──
    const catY = statsY + 24;
    sectionLabel('Spending by Category', catY);

    autoTable(doc, {
      startY: catY + 5,
      head: [['Category', 'Amount', '% of Total', 'Receipts']],
      body: sortedCats.map(([cat, amt]) => {
        const count = expenses.filter(e => (e.category || 'Other') === cat).length;
        return [
          cat,
          `$${formatAmount(amt)}`,
          `${totalSpend > 0 ? ((amt / totalSpend) * 100).toFixed(1) : '0.0'}%`,
          String(count),
        ];
      }),
      headStyles: {
        fillColor: INDIGO,
        textColor: WHITE,
        fontSize: 8,
        fontStyle: 'bold',
        cellPadding: 3,
      },
      bodyStyles: { fontSize: 8, cellPadding: 2.5 },
      alternateRowStyles: { fillColor: INDIGO_LIGHT },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'center' },
      },
      margin: { left: 14, right: 14 },
      tableLineColor: INDIGO_MID,
      tableLineWidth: 0.2,
    });

    drawPageFooter();

    // ─────────────────────────────────────
    //  PAGE 2 — Monthly Trend + Merchants
    // ─────────────────────────────────────
    doc.addPage();
    drawPageHeader(2, 3);

    let y2 = 22;

    // Monthly trend table
    sectionLabel('Monthly Spending Trend', y2);
    y2 += 5;

    autoTable(doc, {
      startY: y2,
      head: [['Month', 'Total Spent', 'vs Average', 'Running Total']],
      body: (() => {
        let running = 0;
        return sortedMonths.map(([month, amt]) => {
          running += amt;
          const vsAvg = amt - avgMonthly;
          const vsStr = vsAvg >= 0 ? `+$${formatAmount(vsAvg)}` : `-$${formatAmount(Math.abs(vsAvg))}`;
          const label = new Date(month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
          return [label, `$${formatAmount(amt)}`, vsStr, `$${formatAmount(running)}`];
        });
      })(),
      headStyles: { fillColor: INDIGO, textColor: WHITE, fontSize: 8, fontStyle: 'bold', cellPadding: 3 },
      bodyStyles: { fontSize: 8, cellPadding: 2.5 },
      alternateRowStyles: { fillColor: GRAY_50 },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 2) {
          const val = String(data.cell.raw);
          if (val.startsWith('+')) {
            data.cell.styles.textColor = [220, 38, 38]; // red = over avg
          } else {
            data.cell.styles.textColor = GREEN_FG;
          }
          data.cell.styles.fontStyle = 'bold';
        }
      },
      margin: { left: 14, right: 14 },
      tableLineColor: GRAY_200,
      tableLineWidth: 0.2,
    });

    y2 = doc.lastAutoTable.finalY + 12;

    // Top merchants table
    sectionLabel('Top Merchants by Spend', y2);
    y2 += 5;

    autoTable(doc, {
      startY: y2,
      head: [['Rank', 'Merchant', 'Total Spent', '% of Total', 'Transactions']],
      body: sortedMerchants.slice(0, 10).map(([merchant, amt], i) => {
        const count = expenses.filter(e => e.merchant === merchant).length;
        return [
          `#${i + 1}`,
          merchant,
          `$${formatAmount(amt)}`,
          `${totalSpend > 0 ? ((amt / totalSpend) * 100).toFixed(1) : '0.0'}%`,
          String(count),
        ];
      }),
      headStyles: { fillColor: INDIGO, textColor: WHITE, fontSize: 8, fontStyle: 'bold', cellPadding: 3 },
      bodyStyles: { fontSize: 8, cellPadding: 2.5 },
      alternateRowStyles: { fillColor: INDIGO_LIGHT },
      columnStyles: {
        0: { halign: 'center', cellWidth: 12 },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'center' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 0 && data.row.index === 0) {
          data.cell.styles.textColor = INDIGO;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      margin: { left: 14, right: 14 },
      tableLineColor: GRAY_200,
      tableLineWidth: 0.2,
    });

    drawPageFooter();

    // ─────────────────────────────────────
    //  PAGE 3 — Full Transaction Log
    // ─────────────────────────────────────
    doc.addPage();
    drawPageHeader(3, 3);

    let y3 = 22;
    sectionLabel(`All Transactions  (${expenses.length} total)`, y3);
    y3 += 5;

    autoTable(doc, {
      startY: y3,
      head: [['Date', 'Merchant', 'Category', 'Amount', 'Summary']],
      body: expenses.map(e => [
        formatDate(e.date),
        e.merchant || '—',
        e.category || 'Other',
        `$${formatAmount(e.total)}`,
        (e.summary || '').slice(0, 52),
      ]),
      headStyles: {
        fillColor: INDIGO,
        textColor: WHITE,
        fontSize: 8,
        fontStyle: 'bold',
        cellPadding: 3,
      },
      bodyStyles: { fontSize: 7.5, cellPadding: 2.2 },
      alternateRowStyles: { fillColor: GRAY_50 },
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 38 },
        2: { cellWidth: 28 },
        3: { halign: 'right', cellWidth: 22 },
        4: { cellWidth: 'auto' },
      },
      // Grand total footer row
      foot: [[
        '', '', 'TOTAL',
        `$${formatAmount(totalSpend)}`,
        `${expenses.length} transaction${expenses.length !== 1 ? 's' : ''}`,
      ]],
      footStyles: {
        fillColor: INDIGO_DARK,
        textColor: WHITE,
        fontStyle: 'bold',
        fontSize: 8.5,
        cellPadding: 3,
      },
      margin: { left: 14, right: 14 },
      tableLineColor: GRAY_200,
      tableLineWidth: 0.15,
      showFoot: 'lastPage',
    });

    drawPageFooter();

    doc.save(`xpense-report-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  // ── Chat message render helper ─────────────────────────────────────────────
  const renderChatMessages = () => (
    <>
      {messages.map((msg) => (
        <div key={msg.id} className={`chat-message ${msg.role}`}>
          {msg.role === 'ai' && (
            <div className="chat-avatar ai-avatar"><AIIcon /></div>
          )}
          <div className="chat-bubble-wrap">
            <div className={`chat-bubble ${msg.isError ? 'chat-bubble-error' : ''}`}>
              {msg.role === 'ai' && !msg.isError
                ? <MarkdownMessage text={msg.text}/>
                : msg.text}
            </div>
            <div className="chat-time">
              {msg.time instanceof Date
                ? msg.time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                : msg.time}
            </div>
          </div>
          {msg.role === 'user' && (
            <div className="chat-avatar user-avatar">{userName[0].toUpperCase()}</div>
          )}
        </div>
      ))}

      {chatLoading && (
        <div className="chat-message ai">
          <div className="chat-avatar ai-avatar"><AIIcon /></div>
          <div className="chat-bubble-wrap">
            <div className="chat-bubble typing-bubble"><span/><span/><span/></div>
          </div>
        </div>
      )}
      <div ref={chatEndRef}/>
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
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
            {
              id: 'expenses', label: 'Expenses',
              icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
            },
            {
              id: 'analytics', label: 'Analytics',
              icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
            },
            {
              id: 'upload', label: 'Upload Receipt',
              icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>,
            },
            {
              id: 'chat', label: 'AI Assistant',
              icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
            },
          ].map(t => (
            <button
              key={t.id}
              className={`nav-item ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
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

        <header className="main-header">
          <div className="header-left">
            <h1 className="page-title">
              {activeTab === 'expenses'  && 'Expenses'}
              {activeTab === 'analytics' && 'Analytics'}
              {activeTab === 'upload'    && 'Upload Receipt'}
              {activeTab === 'chat'      && 'AI Assistant'}
            </h1>
            <p className="page-subtitle">
              {activeTab === 'expenses'  && `${expenses.length} transaction${expenses.length !== 1 ? 's' : ''} · click any row to see details`}
              {activeTab === 'analytics' && 'Visual breakdown of your spending + AI forecast'}
              {activeTab === 'upload'    && 'Drop a receipt — AI extracts and categorizes automatically'}
              {activeTab === 'chat'      && 'Context-aware AI · remembers your conversation · voice enabled'}
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
              {/* ── VISIBLE EXPORT PDF BUTTON ── */}
              <button className="btn-primary sm export-pdf-btn" onClick={exportPDF} title="Export PDF Report">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="12" y1="18" x2="12" y2="12"/>
                  <line x1="9" y1="15" x2="15" y2="15"/>
                </svg>
                Export PDF
              </button>
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
                      <div className="sk sk-md"/><div className="sk sk-lg"/>
                      <div className="sk sk-sm"/><div className="sk sk-xl"/>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="expenses-table-wrap">
                  <table className="expenses-table">
                    <thead>
                      <tr>
                        <th>Date</th><th>Merchant</th><th>Category</th>
                        <th>Amount</th><th>Summary</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenses.length === 0 && !fetchError ? (
                        <tr><td colSpan="6">
                          <div className="empty-state">
                            <div className="empty-icon">🧾</div>
                            <div className="empty-title">No expenses yet</div>
                            <div className="empty-sub">Upload your first receipt to get started</div>
                            <button className="btn-primary sm" onClick={() => setActiveTab('upload')}>
                              Upload Receipt
                            </button>
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
                            <td><span className="category-chip">{expense.category || 'Other'}</span></td>
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

          {/* ── ANALYTICS TAB ── */}
          {activeTab === 'analytics' && (
            <div className="tab-panel fade-in analytics-panel">
              {expenses.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📊</div>
                  <div className="empty-title">No data yet</div>
                  <div className="empty-sub">Upload receipts to see your analytics</div>
                </div>
              ) : (
                <>
                  <div className="charts-row">
                    <div className="chart-card">
                      <div className="chart-title">Spend by Category</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie
                            data={categoryData} dataKey="value" nameKey="name"
                            cx="50%" cy="50%" outerRadius={90}
                            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                            labelLine={false}
                          >
                            {categoryData.map((_, i) => (
                              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]}/>
                            ))}
                          </Pie>
                          <Tooltip formatter={(v) => `$${formatAmount(v)}`}/>
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="chart-card">
                      <div className="chart-title">Monthly Spending Trend</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart data={monthlyData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6"/>
                          <XAxis dataKey="month" tick={{ fontSize: 11 }}/>
                          <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }}/>
                          <Tooltip formatter={(v) => `$${formatAmount(v)}`}/>
                          <Bar dataKey="total" fill="#4F46E5" radius={[4, 4, 0, 0]}/>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="chart-card chart-card-wide">
                    <div className="chart-title">Top 5 Merchants by Spend</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={merchantData} layout="vertical">
                        <XAxis type="number" tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }}/>
                        <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 12 }}/>
                        <Tooltip formatter={(v) => `$${formatAmount(v)}`}/>
                        <Bar dataKey="total" fill="#818CF8" radius={[0, 4, 4, 0]}/>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="chart-card chart-card-wide forecast-card">
                    <div className="chart-title-row">
                      <div className="chart-title">AI Spending Forecast</div>
                      <button
                        className="forecast-btn"
                        onClick={handleForecast}
                        disabled={forecastLoading}
                      >
                        {forecastLoading
                          ? <><div className="btn-spinner"/>Analyzing…</>
                          : 'Generate Forecast'}
                      </button>
                    </div>

                    {!forecastText && !forecastLoading && (
                      <p className="forecast-hint">
                        Click "Generate Forecast" — the AI analyzes your spending patterns and predicts next month's expenses by category.
                      </p>
                    )}

                    {forecastLoading && (
                      <div className="forecast-loading">
                        <div className="forecast-dots"><span/><span/><span/></div>
                        <span>Analyzing your spending patterns…</span>
                      </div>
                    )}

                    {forecastText && !forecastLoading && (
                      <div className="forecast-result">
                        <MarkdownMessage text={forecastText}/>
                      </div>
                    )}
                  </div>

                  <div className="analytics-export-row">
                    <button className="btn-primary" onClick={exportPDF}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <line x1="9" y1="15" x2="15" y2="15"/>
                      </svg>
                      Export Full PDF Report
                    </button>
                  </div>
                </>
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

                {uploadSuccess && (
                  <div className="upload-success">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <div>
                      <strong>Receipt uploaded!</strong>
                      <span className="upload-success-sub"> AI is extracting and categorizing it — your expenses will update automatically.</span>
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
                    <p>AI extracts every line item, merchant, date, and total — then auto-categorizes the expense.</p>
                  </div>
                  <div className="hint-card">
                    <span>📧</span>
                    <p>A confirmation email with full itemised breakdown is sent to <strong>{userEmail}</strong> after processing.</p>
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
            <div className="chat-shell fade-in">

              {/* Sessions Sidebar */}
              <div className="sessions-sidebar">
                <div className="sessions-sidebar-header">
                  <button className="btn-primary sm sessions-new-btn" onClick={handleNewChat}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                    New Chat
                  </button>
                </div>

                <div className="sessions-label">Past Sessions</div>

                <div className="sessions-list">
                  {sessionsLoading && (
                    <div className="sessions-loading">
                      <div className="sk sk-xl" style={{ height: 12, margin: '8px 0' }}/>
                      <div className="sk sk-lg" style={{ height: 12, margin: '8px 0' }}/>
                      <div className="sk sk-xl" style={{ height: 12, margin: '8px 0' }}/>
                    </div>
                  )}
                  {!sessionsLoading && pastSessions.length === 0 && (
                    <div className="sessions-empty">
                      No past sessions yet.<br/>Start chatting!
                    </div>
                  )}
                  {pastSessions.map(sid => {
                    const isActive = sid === sessionId;
                    return (
                      <button
                        key={sid}
                        className={`session-btn ${isActive ? 'session-btn-active' : ''}`}
                        onClick={() => loadSession(sid)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span className="session-btn-label">{formatSessionLabel(sid)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Chat Area */}
              <div className="chat-area">
                <div className="chat-messages">
                  {renderChatMessages()}
                </div>

                {messages.length <= 1 && (
                  <div className="chat-suggestions">
                    {QUICK_SUGGESTIONS.map(s => (
                      <button key={s} className="suggestion-chip" onClick={() => handleChat(s)}>{s}</button>
                    ))}
                  </div>
                )}

                <div className="chat-input-bar">
                  <button
                    className={`voice-btn ${isListening ? 'listening' : ''}`}
                    onClick={isListening ? stopVoice : startVoice}
                    title={isListening ? 'Stop listening' : 'Voice input'}
                    disabled={chatLoading}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  </button>

                  <input
                    type="text"
                    className="chat-input"
                    placeholder={isListening ? '🎙 Listening…' : 'Ask about your expenses…'}
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleChat()}
                    disabled={chatLoading || isListening}
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

                <div className="memory-indicator">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                  {sessionId ? 'Memory active · AI remembers this session' : 'Memory ready · starts on first message'}
                </div>
              </div>
            </div>
          )}

        </div>
      </main>

      {selectedExpense && (
        <ExpenseDetailPanel expense={selectedExpense} onClose={() => setSelectedExpense(null)}/>
      )}
    </div>
  );
}