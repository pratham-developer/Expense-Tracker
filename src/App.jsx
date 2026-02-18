import { useAuth } from "react-oidc-context";
import Dashboard from "./dashboard"; // Import the new component
import './App.css'

function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return <div>Loading...</div>;
  }

  if (auth.error) {
    return <div>Encountering error... {auth.error.message}</div>;
  }

  if (auth.isAuthenticated) {
    // PASS THE USER DATA TO DASHBOARD
    return (
      <Dashboard 
          user={auth.user} 
          signOut={() => auth.removeUser()} 
      />
    );
  }

  return (
    <div className="card">
      <h1>Expense Tracker</h1>
      <p>Log in to scan receipts and track expenses.</p>
      <button onClick={() => auth.signinRedirect()}>Sign in with AWS Cognito</button>
    </div>
  );
}

export default App;