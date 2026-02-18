import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();
const TABLE  = process.env.DYNAMODB_TABLE || "Expenses";

// ── Utilities ─────────────────────────────────────────────────────────────────
const log = (level, msg, data = {}) =>
  console[level](JSON.stringify({ level: level.toUpperCase(), msg, ...data }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** Map a raw DynamoDB Item to a clean JS object for the frontend */
const mapItem = (item) => {
  let items = [];
  try {
    items = item.lineItems?.S ? JSON.parse(item.lineItems.S) : [];
  } catch {
    items = [];
  }
  return {
    expenseId:   item.expenseId?.S    ?? "",
    merchant:    item.merchant?.S     ?? "Unknown",
    date:        item.date?.S         ?? "",
    total:       parseFloat(item.total?.N ?? "0"),
    summary:     item.summary?.S      ?? "",
    items,
    processedAt: item.processedAt?.S  ?? null,
  };
};

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") return respond(200, "");

  const userId = event.queryStringParameters?.userId?.trim();

  if (!userId) {
    return respond(400, { error: "Missing required parameter: userId" });
  }
  if (!userId.includes("@") || userId.length > 320) {
    return respond(400, { error: "Invalid userId format" });
  }

  log("info", "Fetching expenses", { userId });

  try {
    const expenses = [];
    let lastKey    = undefined;

    // Paginate — DynamoDB returns max 1 MB per call
    do {
      const res = await client.send(new QueryCommand({
        TableName: TABLE,
        // Query by partition key only — no FilterExpression on primary key attributes
        // (DynamoDB forbids filtering on partition/sort keys in FilterExpression)
        KeyConditionExpression:    "userId = :uid",
        ExpressionAttributeValues: { ":uid": { S: userId } },
        ExclusiveStartKey: lastKey,
      }));

      for (const item of res.Items ?? []) {
        // Skip internal idempotency lock records written by the OCR Lambda
        // (userId = "__lock__") — these will never appear here because we're
        // querying a specific userId, but guard defensively.
        // The real guard: expenseId on lock records starts with no timestamp digits
        // when ttl is present and userId is the queried user's own locks.
        if (item.ttl) continue; // Lock records always have a TTL; real expenses don't

        expenses.push(mapItem(item));
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    // Sort newest-first by date, then by expenseId (epoch ms) as tiebreaker
    expenses.sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) return dateDiff;
      return parseInt(b.expenseId || "0") - parseInt(a.expenseId || "0");
    });

    log("info", "Expenses fetched", { userId, count: expenses.length });
    return respond(200, expenses);

  } catch (err) {
    log("error", "DynamoDB query failed", { userId, error: err.message });
    return respond(500, { error: "Failed to fetch expenses. Please try again." });
  }
};
