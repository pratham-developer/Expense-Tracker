import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

// *** CONFIGURATION ***
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY"; 

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { question, userId } = body;

    if (!question || !userId) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing question or userId" }) };
    }

    // 1. Fetch User's Data from DynamoDB
    const command = new QueryCommand({
      TableName: "Expenses",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": { S: userId } },
    });

    const dbResponse = await client.send(command);
    
    // Format data as a simple string for the AI
    const expenses = dbResponse.Items.map(item => 
        `- Date: ${item.date.S}, Merchant: ${item.merchant.S}, Total: $${item.total.N}, Summary: ${item.summary.S}`
    ).join("\n");

    // 2. Ask Gemini
    const prompt = `
      You are a helpful financial assistant. 
      Here is the user's expense history:
      ${expenses}

      User Question: "${question}"

      Answer the question based strictly on the data above. Be concise and friendly.
      If the answer is not in the data, say "I can't find that information."
    `;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const apiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    const data = await apiResponse.json();
    const answer = data.candidates[0].content.parts[0].text;

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
      },
      body: JSON.stringify({ answer }),
    };

  } catch (error) {
    console.error("Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};