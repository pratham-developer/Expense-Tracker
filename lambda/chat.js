// chat.js — COMPLETE FILE
import { DynamoDBClient, QueryCommand, ScanCommand }      from "@aws-sdk/client-dynamodb";
import { ChatGoogleGenerativeAI }                          from "@langchain/google-genai";
import { DynamoDBChatMessageHistory }                      from "@langchain/community/stores/message/dynamodb";
import { RunnableWithMessageHistory }                      from "@langchain/core/runnables";
import { ChatPromptTemplate, MessagesPlaceholder }         from "@langchain/core/prompts";
import { StringOutputParser }                              from "@langchain/core/output_parsers";

const dbClient     = new DynamoDBClient();
const TABLE        = process.env.DYNAMODB_TABLE || "Expenses";
const MEMORY_TABLE = process.env.MEMORY_TABLE   || "XpenseMemory";
const GEMINI_MODEL = process.env.GEMINI_MODEL   || "gemini-2.5-flash";

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
  body: JSON.stringify(body),
});

// ── Fetch all expenses ────────────────────────────────────────────────────────
const fetchExpenses = async (userId) => {
  const expenses = [];
  let lastKey    = undefined;

  do {
    const res = await dbClient.send(new QueryCommand({
      TableName:                 TABLE,
      KeyConditionExpression:    "userId = :uid",
      ExpressionAttributeValues: { ":uid": { S: userId } },
      ExclusiveStartKey:         lastKey,
    }));

    for (const item of res.Items ?? []) {
      if (item.userId?.S === "__lock__") continue;

      let lineItems = [];
      try { lineItems = item.lineItems?.S ? JSON.parse(item.lineItems.S) : []; } catch {}

      expenses.push({
        expenseId:   item.expenseId?.S  ?? "",
        merchant:    item.merchant?.S   ?? "Unknown",
        date:        item.date?.S       ?? "",
        total:       parseFloat(item.total?.N ?? "0"),
        summary:     item.summary?.S    ?? "",
        category:    item.category?.S   ?? "Other",
        items:       lineItems,
        processedAt: item.processedAt?.S ?? "",
      });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return expenses.sort((a, b) => new Date(b.date) - new Date(a.date));
};

// ── Analytics ─────────────────────────────────────────────────────────────────
const buildAnalytics = (expenses) => {
  if (!expenses.length) return null;

  const fmt        = (n) => `$${n.toFixed(2)}`;
  const grandTotal = expenses.reduce((s, e) => s + e.total, 0);

  const byMerchant = {};
  for (const e of expenses) {
    byMerchant[e.merchant] = (byMerchant[e.merchant] ?? 0) + e.total;
  }
  const topMerchants = Object.entries(byMerchant)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, total]) => `${name}: ${fmt(total)}`).join(", ");

  const byMonth = {};
  for (const e of expenses) {
    const month = e.date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + e.total;
  }
  const monthlyBreakdown = Object.entries(byMonth)
    .sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6)
    .map(([m, t]) => `${m}: ${fmt(t)}`).join(", ");

  const byCategory = {};
  for (const e of expenses) {
    const cat = e.category || "Other";
    byCategory[cat] = (byCategory[cat] ?? 0) + e.total;
  }
  const categoryBreakdown = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, total]) => `${cat}: ${fmt(total)}`).join(", ");

  const now            = new Date();
  const thisMonth      = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonthTotal = byMonth[thisMonth] ?? 0;

  const allItems = expenses.flatMap((e) =>
    (e.items ?? []).map((i) => ({
      receiptDate: e.date,
      merchant:    e.merchant,
      category:    e.category,
      name:        i.name,
      price:       parseFloat(i.price ?? 0),
    }))
  );

  const topItems = [...allItems]
    .sort((a, b) => b.price - a.price).slice(0, 10)
    .map((i) => `${i.name} from ${i.merchant} (${i.receiptDate}): $${i.price.toFixed(2)}`).join("\n    ");

  return { grandTotal, topMerchants, monthlyBreakdown, categoryBreakdown, thisMonthTotal, allItems, topItems, fmt };
};

const buildExpenseContext = (expenses) => {
  if (!expenses.length) return "No expenses found for this user.";

  return expenses.map((e, idx) => {
    const itemLines = (e.items ?? []).length
      ? e.items.map((i) => `      • ${i.name}: $${parseFloat(i.price ?? 0).toFixed(2)}`).join("\n")
      : "      (no line items)";

    return `${idx + 1}. [${e.date}] ${e.merchant} (${e.category}) — Total: $${e.total.toFixed(2)}
   Summary: ${e.summary}
   Line Items:\n${itemLines}`;
  }).join("\n\n");
};

const buildAnalyticsSection = (analytics) => `
── SPENDING ANALYTICS ──────────────────────────────────────
Grand Total (all time)   : ${analytics.fmt(analytics.grandTotal)}
This Month               : ${analytics.fmt(analytics.thisMonthTotal)}
Top Merchants            : ${analytics.topMerchants}
By Category              : ${analytics.categoryBreakdown}
Monthly Breakdown (last 6): ${analytics.monthlyBreakdown}
Total Line Items on file : ${analytics.allItems.length}

Top 10 Highest-Priced Items:
    ${analytics.topItems || "N/A"}
────────────────────────────────────────────────────────────`;

const sanitizeQuestion = (q) => {
  const trimmed = q.trim().slice(0, 2000); // increased limit for forecast prompts
  if (/ignore (previous|above|all) instructions/i.test(trimmed))
    throw new Error("Invalid question content");
  return trimmed;
};

const buildChain = (expenseContext, analyticsSection) => {
  const llm = new ChatGoogleGenerativeAI({
    model:           GEMINI_MODEL,
    apiKey:          process.env.GEMINI_API_KEY,
    temperature:     0.2,
    maxOutputTokens: 1024,
  });

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are Xpense AI, a friendly and precise personal finance assistant.
You only answer questions based on the expense data provided below.
Be concise, friendly, and format numbers as currency (e.g. $12.50).
You remember this conversation — refer to previous messages naturally when relevant.

IMPORTANT: When asked to forecast or predict future spending, you MUST produce estimates.
Use historical averages and category proportions to project — never refuse to estimate.

${analyticsSection}

── FULL EXPENSE HISTORY ──────────────────────────────────────
${expenseContext}
─────────────────────────────────────────────────────────────`,
    ],
    new MessagesPlaceholder("history"),
    ["human", "{question}"],
  ]);

  return prompt.pipe(llm).pipe(new StringOutputParser());
};

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return respond(200, "");

  if (!process.env.GEMINI_API_KEY) {
    log("error", "GEMINI_API_KEY not set");
    return respond(500, { error: "Server configuration error" });
  }

  let body;
  try { body = JSON.parse(event.body ?? "{}"); }
  catch { return respond(400, { error: "Invalid JSON body" }); }

  // ── Action: listSessions ───────────────────────────────────────────────────
  if (body.action === "listSessions") {
    const { userId } = body;
    if (!userId) return respond(400, { error: "Missing userId" });

    try {
      const res = await dbClient.send(new ScanCommand({
        TableName:        MEMORY_TABLE,
        FilterExpression: "begins_with(sessionId, :prefix)",
        ExpressionAttributeValues: { ":prefix": { S: userId } },
        ProjectionExpression: "sessionId",
      }));

      const sessions = [...new Set(
        (res.Items ?? [])
          .map((i) => i.sessionId?.S)
          .filter((s) => s && !s.includes("#forecast"))
      )].sort((a, b) => b.localeCompare(a)).slice(0, 30);

      log("info", "listSessions complete", { userId, count: sessions.length });
      return respond(200, { sessions });
    } catch (err) {
      log("error", "listSessions failed", { error: err.message });
      return respond(500, { error: "Failed to list sessions" });
    }
  }

  // ── Action: getSession ─────────────────────────────────────────────────────
  if (body.action === "getSession") {
    const { userId, sessionId: sid } = body;
    if (!userId || !sid) return respond(400, { error: "Missing userId or sessionId" });
    if (!sid.startsWith(userId)) return respond(403, { error: "Forbidden" });

    try {
      const history = new DynamoDBChatMessageHistory({
        tableName:    MEMORY_TABLE,
        sessionId:    sid,
        partitionKey: "sessionId",
        config: { region: process.env.AWS_REGION || "us-east-1" },
      });
      const msgs       = await history.getMessages();
      const serialized = msgs.map((m) => ({
        role: m._getType() === "human" ? "user" : "ai",
        text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));
      log("info", "getSession complete", { sid, count: serialized.length });
      return respond(200, { messages: serialized, sessionId: sid });
    } catch (err) {
      log("error", "getSession failed", { error: err.message });
      return respond(500, { error: "Failed to load session" });
    }
  }

  // ── Main chat ──────────────────────────────────────────────────────────────
  const { question: rawQuestion, userId, sessionId: rawSession } = body;

  if (!rawQuestion || !userId)
    return respond(400, { error: "Missing required fields: question, userId" });

  const today     = new Date().toISOString().slice(0, 10);
  const sessionId = rawSession || `${userId}#${today}`;

  let question;
  try { question = sanitizeQuestion(rawQuestion); }
  catch (e) { return respond(400, { error: e.message }); }

  log("info", "Chat request", { userId, sessionId, questionLength: question.length });

  try {
    const expenses         = await fetchExpenses(userId);
    const analytics        = buildAnalytics(expenses);
    const expContext       = buildExpenseContext(expenses);
    const analyticsSection = analytics ? buildAnalyticsSection(analytics) : "No expense data yet.";

    log("info", "Data loaded", { userId, expenseCount: expenses.length });

    const getMessageHistory = (sid) =>
      new DynamoDBChatMessageHistory({
        tableName:    MEMORY_TABLE,
        sessionId:    sid,
        partitionKey: "sessionId",
        config: { region: process.env.AWS_REGION || "us-east-1" },
      });

    const chain           = buildChain(expContext, analyticsSection);
    const chainWithMemory = new RunnableWithMessageHistory({
      runnable:           chain,
      getMessageHistory,
      inputMessagesKey:   "question",
      historyMessagesKey: "history",
    });

    const answer = await chainWithMemory.invoke(
      { question },
      { configurable: { sessionId } },
    );

    log("info", "Response generated", { userId, sessionId, answerLength: answer.length });
    return respond(200, { answer, sessionId });

  } catch (err) {
    log("error", "Chat handler failed", { error: err.message, stack: err.stack });
    return respond(500, { error: "An unexpected error occurred. Please try again." });
  }
};