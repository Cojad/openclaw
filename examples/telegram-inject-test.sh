#!/usr/bin/env bash
# Test script for Telegram injection endpoint

set -e

GATEWAY_URL="${GATEWAY_URL:-http://localhost:18789}"
INJECT_TOKEN="${INJECT_TOKEN:-your-secret-token}"
ACCOUNT_ID="${ACCOUNT_ID:-main}"

echo "Testing Telegram injection endpoint..."
echo "Gateway: $GATEWAY_URL"
echo "Account: $ACCOUNT_ID"
echo ""

# Test update with basic message
UPDATE_JSON='{
  "update": {
    "update_id": 999999,
    "message": {
      "message_id": 12345,
      "from": {
        "id": 987654321,
        "is_bot": true,
        "first_name": "TestBot",
        "username": "testbot"
      },
      "chat": {
        "id": 123456789,
        "type": "private"
      },
      "date": '$(date +%s)',
      "text": "Hello from injected message! This is a test from an external MTProto client."
    }
  },
  "accountId": "'$ACCOUNT_ID'"
}'

echo "Sending test update..."
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$GATEWAY_URL/telegram/inject" \
  -H "Authorization: Bearer $INJECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$UPDATE_JSON")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

echo "HTTP Status: $HTTP_CODE"
echo "Response:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" = "202" ]; then
  echo "✅ Success! Update was accepted and processed."
elif [ "$HTTP_CODE" = "401" ]; then
  echo "❌ Authentication failed. Check INJECT_TOKEN."
elif [ "$HTTP_CODE" = "503" ]; then
  echo "❌ Injection not enabled. Check config:"
  echo "   channels.telegram.accounts.$ACCOUNT_ID.inject.enabled = true"
else
  echo "❌ Request failed with HTTP $HTTP_CODE"
fi
