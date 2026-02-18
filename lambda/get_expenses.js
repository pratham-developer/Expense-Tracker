import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

export const handler = async (event) => {
  // We get the userId (email) from the URL query parameters
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing userId parameter" }) };
  }

  try {
    const command = new QueryCommand({
      TableName: "Expenses",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": { S: userId } },
    });

    const response = await client.send(command);
    
    // Clean up data for React
    const expenses = response.Items.map(item => ({
        expenseId: item.expenseId.S,
        merchant: item.merchant.S,
        date: item.date.S,
        total: parseFloat(item.total.N),
        summary: item.summary?.S || "",
        items: item.lineItems ? JSON.parse(item.lineItems.S) : []
    }));

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*", // CRITICAL for React
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,GET"
      },
      body: JSON.stringify(expenses),
    };

  } catch (error) {
    console.error("Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};