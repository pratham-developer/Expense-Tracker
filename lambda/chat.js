import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TABLE          = process.env.DYNAMODB_TABLE || "Expenses";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || "gemini-2.5-flash";

// ── Utilities ─────────────────────────────────────────────────────────────────
const log = (level, msg, data = {}) =>
  console[level](JSON.stringify({ level: level.toUpperCase(), msg, ...data }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

// ── Fetch all user expenses from DynamoDB (paginated) ─────────────────────────
const fetchExpenses = async (userId) => {
  const expenses = [];
  let lastKey    = undefined;

  do {
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": { S: userId } },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of res.Items ?? []) {
      // Skip internal lock records
      if (item.userId?.S === "__lock__") continue;

      let lineItems = [];
      try { lineItems = item.lineItems?.S ? JSON.parse(item.lineItems.S) : []; } catch {}

      expenses.push({
        expenseId:   item.expenseId?.S  ?? "",
        merchant:    item.merchant?.S   ?? "Unknown",
        date:        item.date?.S       ?? "",
        total:       parseFloat(item.total?.N ?? "0"),
        summary:     item.summary?.S    ?? "",
        items:       lineItems,          // ← CRITICAL: full line items included
        processedAt: item.processedAt?.S ?? "",
      });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return expenses.sort((a, b) => new Date(b.date) - new Date(a.date));
};

// ── Build rich analytics context for the AI ───────────────────────────────────
const buildAnalytics = (expenses) => {
  if (!expenses.length) return null;

  const fmt = (n) => `$${n.toFixed(2)}`;

  // Total spend
  const grandTotal = expenses.reduce((s, e) => s + e.total, 0);

  // Spend by merchant
  const byMerchant = {};
  for (const e of expenses) {
    byMerchant[e.merchant] = (byMerchant[e.merchant] ?? 0) + e.total;
  }
  const topMerchants = Object.entries(byMerchant)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, total]) => `${name}: ${fmt(total)}`)
    .join(", ");

  // Spend by month
  const byMonth = {};
  for (const e of expenses) {
    const month = e.date.slice(0, 7); // "YYYY-MM"
    byMonth[month] = (byMonth[month] ?? 0) + e.total;
  }
  const monthlyBreakdown = Object.entries(byMonth)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([m, t]) => `${m}: ${fmt(t)}`)
    .join(", ");

  // This month
  const now      = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonthTotal = byMonth[thisMonth] ?? 0;

  // All individual line items across all receipts
  const allItems = expenses.flatMap((e) =>
    (e.items ?? []).map((i) => ({
      receiptDate: e.date,
      merchant:    e.merchant,
      name:        i.name,
      price:       parseFloat(i.price ?? 0),
    }))
  );

  // Top individual items by price
  const topItems = [...allItems]
    .sort((a, b) => b.price - a.price)
    .slice(0, 10)
    .map((i) => `${i.name} from ${i.merchant} (${i.receiptDate}): $${i.price.toFixed(2)}`)
    .join("\n    ");

  return { grandTotal, topMerchants, monthlyBreakdown, thisMonthTotal, allItems, fmt };
};

// ── Format all expenses as structured text for the AI prompt ──────────────────
const buildExpenseContext = (expenses) => {
  if (!expenses.length) return "No expenses found for this user.";

  return expenses.map((e, idx) => {
    const itemLines = (e.items ?? []).length
      ? e.items.map((i) => `      • ${i.name}: $${parseFloat(i.price ?? 0).toFixed(2)}`).join("\n")
      : "      (no line items)";

    return `${idx + 1}. [${e.date}] ${e.merchant} — Total: $${e.total.toFixed(2)}
   Summary: ${e.summary}
   Line Items:\n${itemLines}`;
  }).join("\n\n");
};

// ── Basic prompt injection guard ──────────────────────────────────────────────
const sanitizeQuestion = (q) => {
  const MAX_LEN    = 500;
  const BLOCKLIST  = /ignore (previous|above|all) instructions/i;
  const trimmed    = q.trim().slice(0, MAX_LEN);
  if (BLOCKLIST.test(trimmed)) throw new Error("Invalid question content");
  return trimmed;
};

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return respond(200, "");

  if (!GEMINI_API_KEY) {
    log("error", "GEMINI_API_KEY not set");
    return respond(500, { error: "Server configuration error" });
  }

  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const { question: rawQuestion, userId } = body;

  if (!rawQuestion || !userId) {
    return respond(400, { error: "Missing required fields: question, userId" });
  }

  let question;
  try {
    question = sanitizeQuestion(rawQuestion);
  } catch (e) {
    return respond(400, { error: e.message });
  }

  log("info", "Chat request", { userId, questionLength: question.length });

  try {
    // ── 1. Fetch full expense data ─────────────────────────────────────────
    const expenses    = await fetchExpenses(userId);
    const analytics   = buildAnalytics(expenses);
    const expContext  = buildExpenseContext(expenses);

    log("info", "Data loaded", { userId, expenseCount: expenses.length });

    // ── 2. Build rich prompt ───────────────────────────────────────────────
    const analyticsSection = analytics ? `
── SPENDING ANALYTICS ──────────────────────────────────────
Grand Total (all time): ${analytics.fmt(analytics.grandTotal)}
This Month (${new Date().toLocaleString("default", { month: "long", year: "numeric" })}): ${analytics.fmt(analytics.thisMonthTotal)}
Top Merchants: ${analytics.topMerchants}
Monthly Breakdown (recent): ${analytics.monthlyBreakdown}
Total Individual Items on file: ${analytics.allItems.length}

Top 10 Highest-Priced Items:
    ${analytics.topItems || "N/A"}
────────────────────────────────────────────────────────────` : "";

    const prompt = `You are Xpense AI, a friendly and precise personal finance assistant.
You only answer questions based on the expense data provided below — do not fabricate data.
If the data doesn't contain the answer, say "I don't have that information in your receipts."
Be concise, friendly, and format numbers as currency (e.g. $12.50).
${analyticsSection}

── FULL EXPENSE HISTORY (${expenses.length} receipts) ────────────────────────
${expContext}
─────────────────────────────────────────────────────────────

User Question: "${question}"

Answer:`;

    // ── 3. Call Gemini ─────────────────────────────────────────────────────
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const apiRes = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,  // Low temperature = factual, consistent answers
          topP: 0.9,
          maxOutputTokens: 1024,
        },
      }),
    });

    const data = await apiRes.json();

    if (!apiRes.ok || !data.candidates) {
      const errMsg = data.error?.message ?? JSON.stringify(data);
      log("error", "Gemini API error", { errMsg });
      return respond(500, { error: "AI service temporarily unavailable. Please try again." });
    }

    const answer = data.candidates[0]?.content?.parts?.[0]?.text
      ?? "I wasn't able to generate an answer. Please try rephrasing your question.";

    log("info", "Chat response generated", { userId, answerLength: answer.length });

    return respond(200, { answer });

  } catch (err) {
    log("error", "Chat handler failed", { error: err.message, stack: err.stack });
    return respond(500, { error: "An unexpected error occurred. Please try again." });
  }
};
