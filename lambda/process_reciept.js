// process_receipt.js — COMPLETE FILE
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand }                     from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand }                    from "@aws-sdk/client-ses";
import { extname }                                        from "path";

const s3       = new S3Client();
const dynamodb = new DynamoDBClient();
const ses      = new SESClient();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SENDER_EMAIL   = process.env.SENDER_EMAIL;
const TABLE          = process.env.DYNAMODB_TABLE || "Expenses";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || "gemini-2.5-flash";
const MAX_RETRIES    = 3;

const VALID_CATEGORIES = new Set([
  "Food & Dining",
  "Groceries",
  "Travel & Transport",
  "Shopping",
  "Entertainment",
  "Healthcare",
  "Utilities & Bills",
  "Education",
  "Other",
]);

const CATEGORY_META = {
  "Food & Dining":      { emoji: "🍽️", color: "#F59E0B", bg: "#FFFBEB", border: "#FDE68A" },
  "Groceries":          { emoji: "🛒", color: "#10B981", bg: "#ECFDF5", border: "#A7F3D0" },
  "Travel & Transport": { emoji: "✈️", color: "#3B82F6", bg: "#EFF6FF", border: "#BFDBFE" },
  "Shopping":           { emoji: "🛍️", color: "#8B5CF6", bg: "#F5F3FF", border: "#DDD6FE" },
  "Entertainment":      { emoji: "🎬", color: "#EC4899", bg: "#FDF2F8", border: "#FBCFE8" },
  "Healthcare":         { emoji: "💊", color: "#EF4444", bg: "#FEF2F2", border: "#FECACA" },
  "Utilities & Bills":  { emoji: "⚡", color: "#F97316", bg: "#FFF7ED", border: "#FED7AA" },
  "Education":          { emoji: "📚", color: "#06B6D4", bg: "#ECFEFF", border: "#A5F3FC" },
  "Other":              { emoji: "📦", color: "#6B7280", bg: "#F9FAFB", border: "#E5E7EB" },
};

const log = (level, msg, data = {}) =>
  console[level](JSON.stringify({ level: level.toUpperCase(), msg, ...data }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });

const getMimeType = (key) => {
  const map = {
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
    ".pdf":  "application/pdf",
  };
  return map[extname(key).toLowerCase()] ?? "image/jpeg";
};

const extractJson = (raw) => {
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start   = cleaned.indexOf("{");
  const end     = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1)
    throw new Error(`No JSON found in Gemini response: ${cleaned.slice(0, 300)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
};

const callGemini = async (payload, attempt = 1) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  const data = await res.json();

  if (!res.ok || !data.candidates) {
    const errMsg = data.error?.message ?? JSON.stringify(data);
    if (attempt < MAX_RETRIES) {
      log("warn", `Gemini attempt ${attempt} failed, retrying`, { attempt, errMsg });
      await sleep(2 ** attempt * 400);
      return callGemini(payload, attempt + 1);
    }
    throw new Error(`Gemini failed after ${MAX_RETRIES} attempts: ${errMsg}`);
  }
  return data;
};

const isAlreadyProcessed = async (etag) => {
  const res = await dynamodb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { userId: { S: "__lock__" }, expenseId: { S: etag } },
  }));
  return !!res.Item;
};

const markProcessed = (etag) =>
  dynamodb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      userId:    { S: "__lock__" },
      expenseId: { S: etag },
      ttl:       { N: String(Math.floor(Date.now() / 1000) + 604_800) },
    },
  }));

const buildEmail = (merchant, data, category) => {
  const fmt   = (n) => `$${parseFloat(n).toFixed(2)}`;
  const items = data.items ?? [];
  const meta  = CATEGORY_META[category] ?? CATEGORY_META["Other"];

  const itemRows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #F3F4F6;color:#374151;font-size:14px;">${i.name}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;color:#111827;font-size:14px;">${fmt(i.price)}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:32px 16px;background:#F0F4FF;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(79,70,229,0.12);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#4F46E5 0%,#6366F1 100%);padding:32px 32px 24px;">
      <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.65;margin-bottom:8px;color:#fff;">Receipt Processed ✓</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:-0.5px;color:#fff;">${data.merchant}</div>
      <div style="font-size:13px;opacity:0.65;margin-top:4px;color:#fff;">${data.date}</div>
    </div>

    <!-- Category Badge — full-width stripe -->
    <div style="background:${meta.bg};border-top:3px solid ${meta.border};border-bottom:3px solid ${meta.border};padding:14px 32px;display:flex;align-items:center;gap:12px;">
      <span style="font-size:22px;line-height:1;">${meta.emoji}</span>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9CA3AF;margin-bottom:2px;">Category</div>
        <div style="font-size:15px;font-weight:700;color:${meta.color};">${category}</div>
      </div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <!-- Summary -->
      <div style="font-size:11px;color:#9CA3AF;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:8px;">Summary</div>
      <p style="margin:0 0 28px;color:#4B5563;font-size:14px;line-height:1.65;">${data.summary}</p>

      <!-- Line Items -->
      ${itemRows ? `
      <div style="font-size:11px;color:#9CA3AF;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:8px;">Line Items (${items.length})</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-radius:10px;overflow:hidden;border:1px solid #F3F4F6;">
        <thead>
          <tr style="background:#F9FAFB;">
            <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9CA3AF;font-weight:600;">Item</th>
            <th style="padding:10px 16px;text-align:right;font-size:11px;color:#9CA3AF;font-weight:600;">Price</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>` : ""}

      <!-- Total -->
      <div style="background:linear-gradient(135deg,#EEF2FF,#E0E7FF);border-radius:12px;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;border:1px solid #C7D2FE;">
        <span style="color:#4F46E5;font-size:14px;font-weight:600;">Total Charged</span>
        <span style="color:#312E81;font-size:24px;font-weight:800;">${fmt(data.total)}</span>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;background:#F9FAFB;border-top:1px solid #F3F4F6;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;color:#9CA3AF;">Processed by <strong style="color:#4F46E5;">Xpense</strong></span>
      <span style="font-size:11px;color:#D1D5DB;">${new Date().toUTCString()}</span>
    </div>

  </div>
</body>
</html>`;

  const text = [
    `Receipt Processed: ${data.merchant}`,
    `Date: ${data.date}`,
    `Category: ${meta.emoji} ${category}`,
    `Total: ${fmt(data.total)}`,
    "",
    `Summary: ${data.summary}`,
    "",
    items.length
      ? `Items:\n${items.map((i) => `  • ${i.name}: ${fmt(i.price)}`).join("\n")}`
      : "",
    "",
    `Processed by Xpense · ${new Date().toUTCString()}`,
  ].join("\n");

  return { html, text };
};

export const handler = async (event) => {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY env var");
  if (!SENDER_EMAIL)   throw new Error("Missing SENDER_EMAIL env var");

  const results = [];

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const etag   = record.s3.object.eTag ?? `${bucket}/${key}`;

    log("info", "Processing record", { bucket, key });

    if (key.startsWith("__")) {
      results.push({ key, status: "skipped_system" });
      continue;
    }

    try {
      if (await isAlreadyProcessed(etag)) {
        log("warn", "Already processed, skipping", { key, etag });
        results.push({ key, status: "duplicate" });
        continue;
      }

      const userEmail = key.includes("/") ? key.split("/")[0] : "unknown";
      log("info", "User identified", { userEmail });

      const s3Res     = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const imgBuffer = await streamToBuffer(s3Res.Body);
      const base64    = imgBuffer.toString("base64");
      const mimeType  = getMimeType(key);
      log("info", "File downloaded", { bytes: imgBuffer.length, mimeType });

      // ── Single Gemini call: OCR + categorization in one pass ──────────────
      log("info", "Calling Gemini (OCR + categorize)", { model: GEMINI_MODEL });
      const geminiRes = await callGemini({
        contents: [{
          parts: [
            {
              text: `You are a precise receipt OCR system. Analyze this receipt image and return ONLY a valid JSON object — no markdown, no explanation, no extra text.

Required JSON structure:
{
  "merchant": "Exact store/restaurant name from receipt",
  "date": "YYYY-MM-DD (infer current year if not shown)",
  "total": 123.45,
  "items": [
    { "name": "Item name exactly as on receipt", "price": 10.00 }
  ],
  "summary": "One sentence describing what was purchased",
  "category": "Exactly one value from the list below"
}

Category options (pick the single best fit):
- Food & Dining      → restaurants, cafes, Swiggy, Zomato
- Groceries          → supermarkets, Blinkit, Zepto, DMart
- Travel & Transport → flights, Uber, Ola, fuel stations (Indian Oil, HPCL, BPCL)
- Shopping           → clothing, electronics, Amazon, Flipkart, Myntra
- Entertainment      → movies, gaming, Netflix, Prime Video
- Healthcare         → pharmacy, doctor visits, Apollo, MedPlus, labs
- Utilities & Bills  → electricity, internet, phone recharge, BESCOM, Jio, Airtel
- Education          → courses, books, tuition, Udemy, college fees
- Other              → only if absolutely nothing else fits

General rules:
- Use "Unknown" for missing text fields, 0 for missing numbers
- total must be a number (not a string)
- All item prices must be numbers
- date must be YYYY-MM-DD format
- items array must include ALL line items visible on the receipt
- category must be copied exactly as written above (case-sensitive)`,
            },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, topP: 0.8 },
      });

      const rawText = geminiRes.candidates[0].content.parts[0].text;
      const parsed  = extractJson(rawText);

      // Guard: fall back to "Other" if Gemini returns an unrecognised string
      const category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : "Other";

      log("info", "OCR + categorization complete", {
        merchant:  parsed.merchant,
        total:     parsed.total,
        itemCount: parsed.items?.length ?? 0,
        category,
      });
      // ─────────────────────────────────────────────────────────────────────

      const expenseId = Date.now().toString();

      await dynamodb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          userId:      { S: userEmail },
          expenseId:   { S: expenseId },
          merchant:    { S: parsed.merchant  ?? "Unknown" },
          date:        { S: parsed.date      ?? new Date().toISOString().slice(0, 10) },
          total:       { N: String(parseFloat(parsed.total) || 0) },
          summary:     { S: parsed.summary   ?? "" },
          lineItems:   { S: JSON.stringify(parsed.items ?? []) },
          category:    { S: category },
          s3Key:       { S: key },
          processedAt: { S: new Date().toISOString() },
        },
        ConditionExpression: "attribute_not_exists(expenseId)",
      })).catch((e) => {
        if (e.name !== "ConditionalCheckFailedException") throw e;
        log("warn", "Duplicate expenseId race condition, skipping save");
      });

      log("info", "Saved to DynamoDB", { expenseId, userEmail, category });
      await markProcessed(etag);

      if (userEmail.includes("@")) {
        try {
          const { html, text } = buildEmail(parsed.merchant, parsed, category);
          await ses.send(new SendEmailCommand({
            Source:      SENDER_EMAIL,
            Destination: { ToAddresses: [userEmail] },
            Message: {
              Subject: {
                Data: `🧾 ${parsed.merchant} — $${parseFloat(parsed.total).toFixed(2)} · ${CATEGORY_META[category]?.emoji ?? "📦"} ${category}`,
              },
              Body: {
                Html: { Data: html },
                Text: { Data: text },
              },
            },
          }));
          log("info", "Email sent", { to: userEmail });
        } catch (emailErr) {
          log("error", "SES email failed (non-fatal)", { error: emailErr.message });
        }
      }

      results.push({ key, status: "success", expenseId, merchant: parsed.merchant, category });

    } catch (err) {
      log("error", "Failed to process record", { key, error: err.message, stack: err.stack });
      results.push({ key, status: "error", error: err.message });
      if (event.Records.length === 1) throw err;
    }
  }

  log("info", "Batch complete", { results });
  return { statusCode: 200, body: JSON.stringify(results) };
};