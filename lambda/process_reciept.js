import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { extname } from "path";

// ── AWS Clients ───────────────────────────────────────────────────────────────
const s3       = new S3Client();
const dynamodb = new DynamoDBClient();
const ses      = new SESClient();

// ── Config ────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SENDER_EMAIL   = process.env.SENDER_EMAIL;
const TABLE          = process.env.DYNAMODB_TABLE || "Expenses";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || "gemini-2.5-flash";
const MAX_RETRIES    = 3;

// ── Utilities ─────────────────────────────────────────────────────────────────
const log = (level, msg, data = {}) =>
  console[level](JSON.stringify({ level: level.toUpperCase(), msg, ...data }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end",   () => resolve(Buffer.concat(chunks)));
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

/** Strip markdown fences and extract the outermost JSON object from AI text */
const extractJson = (raw) => {
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start   = cleaned.indexOf("{");
  const end     = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1)
    throw new Error(`No JSON found in Gemini response: ${cleaned.slice(0, 300)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
};

/** Call Gemini with up to MAX_RETRIES attempts using exponential backoff */
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
      await sleep(2 ** attempt * 400); // 800 ms → 1600 ms → ...
      return callGemini(payload, attempt + 1);
    }
    throw new Error(`Gemini failed after ${MAX_RETRIES} attempts: ${errMsg}`);
  }
  return data;
};

/** Return true if this S3 ETag was already processed (idempotency lock) */
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
      // TTL: auto-delete the lock after 7 days
      ttl: { N: String(Math.floor(Date.now() / 1000) + 604_800) },
    },
  }));

// ── Email Builder ─────────────────────────────────────────────────────────────
const buildEmail = (merchant, data) => {
  const fmt   = (n) => `$${parseFloat(n).toFixed(2)}`;
  const items = data.items ?? [];

  const itemRows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:8px 16px;border-bottom:1px solid #F3F4F6;color:#374151;font-size:14px;">${i.name}</td>
        <td style="padding:8px 16px;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:600;color:#111827;font-size:14px;">${fmt(i.price)}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:32px 16px;background:#F5F5F5;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#4F46E5 0%,#6366F1 100%);padding:32px;color:#ffffff;">
      <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:0.75;margin-bottom:6px;">Receipt Processed ✓</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:-0.5px;">${data.merchant}</div>
      <div style="font-size:13px;opacity:0.7;margin-top:6px;">${data.date}</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">

      <!-- Summary -->
      <div style="font-size:11px;color:#9CA3AF;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:8px;">Summary</div>
      <p style="margin:0 0 24px;color:#4B5563;font-size:14px;line-height:1.65;">${data.summary}</p>

      <!-- Items table -->
      ${itemRows ? `
      <div style="font-size:11px;color:#9CA3AF;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:8px;">Line Items (${items.length})</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <thead>
          <tr style="background:#F9FAFB;">
            <th style="padding:8px 16px;text-align:left;font-size:11px;color:#9CA3AF;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
            <th style="padding:8px 16px;text-align:right;font-size:11px;color:#9CA3AF;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>` : ""}

      <!-- Total -->
      <div style="background:#EEF2FF;border-radius:10px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#4F46E5;font-size:14px;font-weight:600;">Total Charged</span>
        <span style="color:#312E81;font-size:22px;font-weight:800;letter-spacing:-0.5px;">${fmt(data.total)}</span>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;background:#F9FAFB;border-top:1px solid #F3F4F6;text-align:center;font-size:12px;color:#9CA3AF;">
      Processed by <strong style="color:#4F46E5;">Xpense</strong> · ${new Date().toUTCString()}
    </div>
  </div>
</body>
</html>`;

  const text = [
    `Receipt Processed: ${data.merchant}`,
    `Date: ${data.date}`,
    `Total: ${fmt(data.total)}`,
    "",
    `Summary: ${data.summary}`,
    "",
    items.length ? `Items:\n${items.map((i) => `  • ${i.name}: ${fmt(i.price)}`).join("\n")}` : "",
  ].join("\n");

  return { html, text };
};

// ── Main Handler ──────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY env var");
  if (!SENDER_EMAIL)   throw new Error("Missing SENDER_EMAIL env var");

  const results = [];

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const etag   = record.s3.object.eTag ?? `${bucket}/${key}`;

    log("info", "Processing record", { bucket, key });

    // Skip system lock items that might re-trigger (edge case)
    if (key.startsWith("__")) { results.push({ key, status: "skipped_system" }); continue; }

    try {
      // ── 0. Idempotency check ────────────────────────────────────────────
      if (await isAlreadyProcessed(etag)) {
        log("warn", "Already processed, skipping", { key, etag });
        results.push({ key, status: "duplicate" });
        continue;
      }

      // ── 1. Identify user from folder path ───────────────────────────────
      //      Format: "user@email.com/1234567890-filename.jpg"
      const userEmail = key.includes("/") ? key.split("/")[0] : "unknown";
      log("info", "User identified", { userEmail });

      // ── 2. Download from S3 ─────────────────────────────────────────────
      const s3Res      = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const imgBuffer  = await streamToBuffer(s3Res.Body);
      const base64     = imgBuffer.toString("base64");
      const mimeType   = getMimeType(key);
      log("info", "File downloaded", { bytes: imgBuffer.length, mimeType });

      // ── 3. OCR via Gemini ───────────────────────────────────────────────
      log("info", "Calling Gemini", { model: GEMINI_MODEL });
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
  "summary": "One sentence describing what was purchased"
}

Rules:
- Use "Unknown" for missing text fields, 0 for missing numbers
- total must be a number (not a string)
- All item prices must be numbers
- date must be YYYY-MM-DD format
- items array must include ALL line items visible on the receipt
- summary should be natural language, e.g. "Grocery shopping including fresh produce, dairy, and pantry staples"`,
            },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0.1, topP: 0.8 },
      });

      const rawText   = geminiRes.candidates[0].content.parts[0].text;
      const parsed    = extractJson(rawText);
      log("info", "Gemini extraction complete", {
        merchant: parsed.merchant,
        total: parsed.total,
        itemCount: parsed.items?.length ?? 0,
      });

      // ── 4. Validate parsed data ─────────────────────────────────────────
      if (!parsed.merchant || parsed.merchant === "Unknown") {
        log("warn", "Low-confidence extraction", { parsed });
      }

      // ── 5. Save to DynamoDB ─────────────────────────────────────────────
      const expenseId = Date.now().toString();
      
      await dynamodb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          userId:    { S: userEmail },
          expenseId: { S: expenseId },
          merchant:  { S: parsed.merchant  ?? "Unknown" },
          date:      { S: parsed.date      ?? new Date().toISOString().slice(0, 10) },
          total:     { N: String(parseFloat(parsed.total) || 0) },
          summary:   { S: parsed.summary   ?? "" },
          lineItems: { S: JSON.stringify(parsed.items ?? []) },
          s3Key:     { S: key },
          processedAt: { S: new Date().toISOString() },
        },
        // Prevent overwrite if something ran in parallel
        ConditionExpression: "attribute_not_exists(expenseId)",
      })) // <--- MOVED CLOSING PARENTHESIS HERE
      .catch((e) => {
        // ConditionalCheckFailedException = already saved, that's fine
        if (e.name !== "ConditionalCheckFailedException") throw e;
        log("warn", "Duplicate expenseId detected (race condition), skipping save");
      });
      
      log("info", "Saved to DynamoDB", { expenseId, userEmail });

      // ── 6. Mark as processed (idempotency) ─────────────────────────────
      await markProcessed(etag);

      // ── 7. Send confirmation email (non-fatal) ──────────────────────────
      if (userEmail.includes("@")) {
        try {
          const { html, text } = buildEmail(parsed.merchant, parsed);
          await ses.send(new SendEmailCommand({
            Source: SENDER_EMAIL,
            Destination: { ToAddresses: [userEmail] },
            Message: {
              Subject: { Data: `🧾 Receipt Processed: ${parsed.merchant} — $${parseFloat(parsed.total).toFixed(2)}` },
              Body: {
                Html: { Data: html },
                Text: { Data: text },
              },
            },
          }));
          log("info", "Confirmation email sent", { to: userEmail });
        } catch (emailErr) {
          // Don't fail the whole lambda if only email breaks
          log("error", "SES email failed (non-fatal)", { error: emailErr.message, hint: "Ensure both sender and receiver are SES-verified in sandbox mode" });
        }
      }

      results.push({ key, status: "success", expenseId, merchant: parsed.merchant });

    } catch (err) {
      log("error", "Failed to process record", { key, error: err.message, stack: err.stack });
      results.push({ key, status: "error", error: err.message });
      // Re-throw if ALL records fail so Lambda marks the invocation as failed
      if (event.Records.length === 1) throw err;
    }
  }

  log("info", "Batch complete", { results });
  return { statusCode: 200, body: JSON.stringify(results) };
};
