import { useState, useEffect } from 'react';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// *** CONFIGURATION ***
// Load configuration from environment variables
const S3_BUCKET = import.meta.env.VITE_S3_BUCKET; 
const REGION = import.meta.env.VITE_AWS_REGION; 
const API_URL = import.meta.env.VITE_API_URL;
const CHAT_API_URL = import.meta.env.VITE_CHAT_API_URL;
const S3_ACCESS_KEY = import.meta.env.VITE_S3_ACCESS_KEY;
const S3_SECRET_KEY = import.meta.env.VITE_S3_SECRET_KEY;

const s3 = new S3Client({
    region: REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
    },
});

const Dashboard = ({ user, signOut }) => {
    // --- STATE ---
    const [file, setFile] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [expenses, setExpenses] = useState([]);
    const [loading, setLoading] = useState(false);
    
    // Chatbot State
    const [question, setQuestion] = useState("");
    const [answer, setAnswer] = useState("");
    const [chatLoading, setChatLoading] = useState(false);

    // Get the email from the OIDC user object
    const userEmail = user?.profile?.email;

    // --- 1. FETCH EXPENSES ---
    const fetchExpenses = async () => {
        if (!userEmail) return;
        setLoading(true);
        try {
            console.log("Fetching from:", `${API_URL}?userId=${userEmail}`);
            
            const response = await fetch(`${API_URL}?userId=${userEmail}`);
            const data = await response.json();
            
            if (Array.isArray(data)) {
                const sortedData = data.sort((a, b) => new Date(b.date) - new Date(a.date));
                setExpenses(sortedData);
            } else {
                console.error("API Error:", data);
                // Don't alert on first load if it's just empty
            }

        } catch (error) {
            console.error("Network/Code Error:", error);
        }
        setLoading(false);
    };

    useEffect(() => {
        fetchExpenses();
    }, [userEmail]);

    // --- 2. UPLOAD FUNCTION ---
    const handleUpload = async () => {
        if (!file) return alert("Please select a file first!");
        if (!userEmail) return alert("User email not found!");

        setUploading(true);
        const fileName = `${userEmail}/${Date.now()}-${file.name}`;

        try {
            // FIX: Convert file to ArrayBuffer to avoid Stream error
            const fileBuffer = await file.arrayBuffer();
            const fileData = new Uint8Array(fileBuffer);

            const command = new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: fileName,
                Body: fileData,
                ContentType: file.type,
            });

            await s3.send(command);
            
            alert("✅ Upload Successful! Processing... (Wait 10-20s for email)");
            setFile(null);
            
            // Auto-refresh table after 15 seconds
            setTimeout(fetchExpenses, 15000);

        } catch (error) {
            console.error("Upload failed:", error);
            alert("Upload failed: " + error.message);
        }
        setUploading(false);
    };

    // --- 3. CHATBOT FUNCTION ---
    const handleChat = async () => {
        if (!question) return;
        setChatLoading(true);
        setAnswer(""); // Clear previous answer
        
        try {
            const response = await fetch(CHAT_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question, userId: userEmail })
            });
            
            const data = await response.json();
            
            if (data.answer) {
                setAnswer(data.answer);
            } else {
                setAnswer("I couldn't get an answer. Check if Chat Lambda is working.");
            }

        } catch (error) {
            console.error("Chat Error:", error);
            setAnswer("Error talking to AI.");
        }
        setChatLoading(false);
    };

    // --- RENDER ---
    return (
        <div className="dashboard-container" style={{ padding: '20px', maxWidth: '800px', margin: '0 auto', fontFamily: 'Arial, sans-serif' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
                <h1 style={{ margin: 0 }}>💰 Expense Tracker</h1>
                <button onClick={signOut} style={{ padding: '8px 16px', background: '#ff4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                    Sign Out ({userEmail})
                </button>
            </div>

            {/* AI Chatbot Section (NEW) */}
            <div style={{ background: '#e3f2fd', padding: '20px', borderRadius: '10px', marginBottom: '30px', border: '1px solid #90caf9' }}>
                <h3 style={{ marginTop: 0 }}>🤖 Ask AI about your finances</h3>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <input 
                        type="text" 
                        placeholder="e.g., How much did I spend on Printing?" 
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        style={{ flex: 1, padding: '12px', borderRadius: '5px', border: '1px solid #ccc' }}
                    />
                    <button 
                        onClick={handleChat} 
                        disabled={chatLoading} 
                        style={{ padding: '10px 25px', background: '#1976d2', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                        {chatLoading ? "Thinking..." : "Ask AI"}
                    </button>
                </div>
                {answer && (
                    <div style={{ marginTop: '15px', padding: '15px', background: 'white', borderRadius: '5px', borderLeft: '5px solid #1976d2', lineHeight: '1.5' }}>
                        <strong>🤖 AI:</strong> {answer}
                    </div>
                )}
            </div>

            {/* Upload Section */}
            <div style={{ background: '#f8f9fa', padding: '25px', borderRadius: '10px', marginBottom: '30px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
                <h3 style={{ marginTop: 0 }}>📤 Upload New Receipt</h3>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '15px' }}>
                    <input type="file" onChange={(e) => setFile(e.target.files[0])} />
                    <button 
                        onClick={handleUpload} 
                        disabled={uploading}
                        style={{ padding: '10px 20px', background: '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                        {uploading ? "Uploading..." : "Upload & Process"}
                    </button>
                </div>
            </div>

            {/* Expenses Table */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3>Recent Expenses</h3>
                <button onClick={fetchExpenses} style={{ cursor: 'pointer', padding: '5px 10px' }}>🔄 Refresh</button>
            </div>

            {loading ? <p>Loading data...</p> : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', background: 'white' }}>
                        <thead>
                            <tr style={{ background: '#eee', borderBottom: '2px solid #ddd' }}>
                                <th style={{ padding: '12px' }}>Date</th>
                                <th style={{ padding: '12px' }}>Merchant</th>
                                <th style={{ padding: '12px' }}>Total</th>
                                <th style={{ padding: '12px' }}>Summary</th>
                            </tr>
                        </thead>
                        <tbody>
                            {expenses.length === 0 ? (
                                <tr><td colSpan="4" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>No expenses found yet. Upload a receipt!</td></tr>
                            ) : (
                                expenses.map((expense) => (
                                    <tr key={expense.expenseId} style={{ borderBottom: '1px solid #eee' }}>
                                        <td style={{ padding: '12px' }}>{expense.date}</td>
                                        <td style={{ padding: '12px', fontWeight: '500' }}>{expense.merchant}</td>
                                        <td style={{ padding: '12px', fontWeight: 'bold', color: '#28a745' }}>${expense.total}</td>
                                        <td style={{ padding: '12px', fontSize: '14px', color: '#555' }}>{expense.summary}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default Dashboard;