import { useAuth } from "react-oidc-context";
import Dashboard from "./dashboard";
import './App.css';

function App() {
  const auth = useAuth();

  const signOut = () => {
    const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
    const logoutUri = import.meta.env.VITE_COGNITO_REDIRECT_URI;
    const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN;

    auth.removeUser();
    window.location.href = `${cognitoDomain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(logoutUri)}`;
  };

  if (auth.isLoading) {
    return (
      <div className="splash-screen">
        <div className="splash-logo">
          <div className="logo-mark">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="10" fill="#4F46E5"/>
              <path d="M8 16h4l3-6 4 12 3-6h4" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span>Xpense</span>
        </div>
        <div className="splash-loader">
          <div className="loader-bar"></div>
        </div>
      </div>
    );
  }

  if (auth.error) {
    return (
      <div className="splash-screen">
        <div className="error-card">
          <div className="error-icon">⚠️</div>
          <h2>Authentication Error</h2>
          <p>{auth.error.message}</p>
          <button className="btn-primary" onClick={() => window.location.reload()}>Try Again</button>
        </div>
      </div>
    );
  }

  if (auth.isAuthenticated) {
    return <Dashboard user={auth.user} signOut={signOut} />;
  }

  return (
    <div className="login-page">
      <div className="login-bg">
        <div className="bg-blob blob-1"></div>
        <div className="bg-blob blob-2"></div>
        <div className="bg-blob blob-3"></div>
        <div className="grid-overlay"></div>
      </div>

      <div className="login-container">
        <div className="login-card">
          <div className="login-brand">
            <div className="brand-icon">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="10" fill="#4F46E5"/>
                <path d="M8 16h4l3-6 4 12 3-6h4" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span className="brand-name">Xpense</span>
          </div>

          <div className="login-hero">
            <h1 className="login-title">
              Track every<br />
              <span className="title-accent">expense, effortlessly.</span>
            </h1>
            <p className="login-subtitle">
              Snap a receipt. Let AI do the rest. Instant insights into your spending.
            </p>
          </div>

          <div className="login-features">
            {[
              { icon: "📸", label: "AI Receipt Scanning" },
              { icon: "💬", label: "Natural Language Queries" },
              { icon: "📊", label: "Instant Analytics" },
            ].map((f) => (
              <div className="feature-pill" key={f.label}>
                <span>{f.icon}</span>
                <span>{f.label}</span>
              </div>
            ))}
          </div>

          <button className="login-btn" onClick={() => auth.signinRedirect()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>
            </svg>
            Sign in with AWS Cognito
          </button>

          <p className="login-footnote">Secured by AWS Cognito · End-to-end encrypted</p>
        </div>

        <div className="login-preview">
          <div className="preview-card pc-1">
            <div className="pc-label">Total this month</div>
            <div className="pc-value">$2,847.50</div>
            <div className="pc-trend up">↑ 12% vs last month</div>
          </div>
          <div className="preview-card pc-2">
            <div className="pc-chat-msg ai">
              <div className="msg-avatar">AI</div>
              <div className="msg-bubble">You spent <strong>$340</strong> on dining last month — 18% of total.</div>
            </div>
          </div>
          <div className="preview-card pc-3">
            <div className="pc-bar-title">Spending by category</div>
            {[
              { label: "Food", pct: 45, color: "#4F46E5" },
              { label: "Travel", pct: 28, color: "#818CF8" },
              { label: "Office", pct: 18, color: "#C7D2FE" },
            ].map(b => (
              <div className="pc-bar-row" key={b.label}>
                <span>{b.label}</span>
                <div className="pc-bar-track">
                  <div className="pc-bar-fill" style={{ width: `${b.pct}%`, background: b.color }}></div>
                </div>
                <span>{b.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;