import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses"; 
import { extname } from "path";

const s3 = new S3Client();
const dynamodb = new DynamoDBClient();
const ses = new SESClient(); 

// *** CONFIGURATION ***
// 1. Your Gemini Key
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"; 
// 2. Your Verified Sender Email (MUST match what you verified in SES)
const SENDER_EMAIL = "your-verified-email@example.com"; 

// Helper to convert S3 stream to Buffer (Fixed logic)
const streamToBuffer = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
};

export const handler = async (event) => {
  console.log("Event Received:", JSON.stringify(event, null, 2));

  try {
    // 1. Get bucket and file key
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
    console.log(`Processing file: ${key} from bucket: ${bucket}`);

    // 2. Identify the User (Email) from folder name
    // Expected format: "user@email.com/filename.jpg"
    let userEmail = "default-user";
    if (key.includes("/")) {
        userEmail = key.split("/")[0];
    }
    console.log(`User identified as: ${userEmail}`);

    // 3. Download from S3
    const getObjectParams = { Bucket: bucket, Key: key };
    const s3Response = await s3.send(new GetObjectCommand(getObjectParams));
    const imageBuffer = await streamToBuffer(s3Response.Body);
    const base64Image = imageBuffer.toString("base64");

    // 4. Determine Mime Type
    const extension = extname(key).toLowerCase();
    let mimeType = "image/jpeg";
    if (extension === ".png") mimeType = "image/png";
    if (extension === ".webp") mimeType = "image/webp";

    // 5. Call Google Gemini 2.0 Flash
    console.log("Sending image to Gemini 2.5 Flash...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `
      Analyze this receipt image. Extract the following details strictly in JSON format:
      {
        "merchant": "Name of store",
        "date": "YYYY-MM-DD",
        "total": 123.45,
        "items": [
           { "name": "Item 1 name", "price": 10.00 },
           { "name": "Item 2 name", "price": 5.50 }
        ],
        "summary": "Short description of items"
      }
      If you can't find a value, use "Unknown" or 0.
      Return ONLY the JSON string, no markdown formatting.
    `;

    const response = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: base64Image } }
                ]
            }]
        })
    });

    const data = await response.json();

    if (!data.candidates) {
        console.error("Gemini API Error:", JSON.stringify(data, null, 2));
        throw new Error(`Gemini API Failed: ${data.error?.message || "Unknown Error"}`);
    }
    
    // 6. Parse Gemini Response
    let aiText = data.candidates[0].content.parts[0].text;
    aiText = aiText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsedData = JSON.parse(aiText);
    console.log("Gemini Extracted Data:", parsedData);

    // 7. Save to DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: "Expenses", 
      Item: {
        userId: { S: userEmail },
        expenseId: { S: Date.now().toString() },
        merchant: { S: parsedData.merchant }, 
        date: { S: parsedData.date },
        total: { N: parsedData.total.toString() },
        summary: { S: parsedData.summary },
        lineItems: { S: JSON.stringify(parsedData.items) } 
      },
    }));
    console.log("Success! Expense saved to Database.");

    // 8. Send Targeted Email via SES
    if (userEmail.includes("@")) {
        console.log(`Sending SES email from ${SENDER_EMAIL} to ${userEmail}...`);
        
        const emailParams = {
            Source: SENDER_EMAIL, // Must be verified in SES
            Destination: { ToAddresses: [userEmail] }, 
            Message: {
                Subject: { Data: `🧾 Receipt Processed: ${parsedData.merchant}` },
                Body: {
                    Text: { 
                        Data: `Merchant: ${parsedData.merchant}\nTotal: $${parsedData.total}\nDate: ${parsedData.date}\n\nSummary: ${parsedData.summary}\n\nItems:\n${parsedData.items.map(i => `- ${i.name}: $${i.price}`).join('\n')}`
                    }
                }
            }
        };

        try {
            await ses.send(new SendEmailCommand(emailParams));
            console.log("✅ Email sent successfully via SES!");
        } catch (err) {
            console.error("❌ SES Email Failed:", err.message);
            console.log("Make sure BOTH Sender and Receiver emails are verified in SES Console (Sandbox Mode).");
        }
    } else {
        console.log("⚠️ Skipping email: User ID is not a valid email address.");
    }
    
    return { statusCode: 200, body: "Receipt processed!" };

  } catch (error) {
    console.error("CRITICAL ERROR:", error);
    return { statusCode: 500, body: error.message };
  }
};