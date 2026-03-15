---
title: "Telegram Update Injection"
summary: "Inject Telegram messages from external MTProto clients (Telethon/GramJS)"
---

# Telegram Update Injection

Inject Telegram messages from external MTProto clients (Telethon, GramJS) into OpenClaw's message processing pipeline.

## Use Case

The Telegram Bot API cannot receive messages from other bots. If you need to process messages from bot accounts, you must use an MTProto client like Telethon or GramJS.

This feature allows you to:

1. Use Telethon/GramJS to poll Telegram messages (including bot messages)
2. Filter the messages according to your criteria
3. Inject qualifying messages into OpenClaw via HTTP POST
4. Process them through the same pipeline as normal bot messages

## Configuration

Enable the injection endpoint in your OpenClaw config:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          botToken: "your-bot-token-here",
          inject: {
            enabled: true,
            token: "your-secret-injection-token",
          },
        },
      },
    },
  },
}
```

**Security note**: The `inject.token` should be a strong secret. It authenticates injection requests.

## API Endpoint

```
POST http://gateway-host:18789/telegram/inject
```

### Headers

```http
Authorization: Bearer your-secret-injection-token
Content-Type: application/json
```

### Request Body

**Private Chat Example:**

```json
{
  "update": {
    "update_id": 123456,
    "message": {
      "message_id": 789,
      "from": {
        "id": 987654321,
        "is_bot": true,
        "first_name": "OtherBot",
        "username": "otherbot"
      },
      "chat": {
        "id": 123456789,
        "type": "private"
      },
      "date": 1234567890,
      "text": "Message from another bot"
    }
  },
  "accountId": "main"
}
```

**Group/Supergroup Example:**

```json
{
  "update": {
    "update_id": 123457,
    "message": {
      "message_id": 790,
      "from": {
        "id": 987654321,
        "is_bot": true,
        "first_name": "OtherBot",
        "username": "otherbot"
      },
      "chat": {
        "id": -1001234567890,
        "type": "supergroup",
        "title": "My Group Name"
      },
      "date": 1234567890,
      "text": "Message in group from another bot"
    }
  },
  "accountId": "main"
}
```

**Fields:**

- `update` (required): Standard Telegram Update object (Bot API format)
- `accountId` (optional): Telegram account ID to use (defaults to first enabled inject account)

### Response

**Success (202 Accepted):**

```json
{
  "ok": true,
  "message": "update processed",
  "updateId": 123456
}
```

**Error (400/401/500):**

```json
{
  "ok": false,
  "error": "error description"
}
```

## Full Metadata Support

The injection endpoint preserves **all** Telegram message metadata:

- ✅ `from` — sender information
- ✅ `message_id` — message ID
- ✅ `reply_to_message` — reply metadata (OpenClaw will reply to this message)
- ✅ `message_thread_id` — forum topic ID
- ✅ `date` — message timestamp
- ✅ `entities` — message formatting
- ✅ All other Update fields

## Example: Telethon Integration

### Python (Telethon)

```python
from telethon import TelegramClient, events
import httpx

# Your MTProto client
client = TelegramClient('session_name', api_id, api_hash)

# OpenClaw injection config
OPENCLAW_URL = "http://localhost:18789/telegram/inject"
OPENCLAW_TOKEN = "your-secret-injection-token"

@client.on(events.NewMessage)
async def handler(event):
    # Filter: only process messages from specific bots
    if not event.sender or not event.sender.bot:
        return
    if event.sender.username not in ['targetbot1', 'targetbot2']:
        return

    # Convert Telethon Update to Bot API format
    chat = await event.get_chat()
    update = {
        "update_id": event.id,
        "message": {
            "message_id": event.message.id,
            "from": {
                "id": event.sender.id,
                "is_bot": event.sender.bot,
                "first_name": event.sender.first_name or "",
                "username": event.sender.username or None,
            },
            "chat": {
                "id": event.chat_id,
                "type": "private" if event.is_private else "supergroup",
                "title": chat.title if hasattr(chat, 'title') else None,
            },
            "date": event.date.timestamp(),
            "text": event.message.text,
        }
    }

    # Add reply_to_message if present
    if event.message.reply_to_msg_id:
        reply_msg = await event.message.get_reply_message()
        if reply_msg:
            update["message"]["reply_to_message"] = {
                "message_id": reply_msg.id,
                "from": {
                    "id": reply_msg.sender_id,
                    "is_bot": reply_msg.sender.bot if reply_msg.sender else False,
                    "first_name": reply_msg.sender.first_name if reply_msg.sender else "",
                },
                "date": reply_msg.date.timestamp(),
                "text": reply_msg.text,
            }

    # Inject into OpenClaw
    async with httpx.AsyncClient() as http:
        response = await http.post(
            OPENCLAW_URL,
            headers={"Authorization": f"Bearer {OPENCLAW_TOKEN}"},
            json={"update": update, "accountId": "main"}
        )
        print(f"Injected update {event.id}: {response.status_code}")

client.start()
client.run_until_disconnected()
```

### JavaScript (GramJS)

```javascript
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });

client.addEventHandler(
  async (event) => {
    // Filter: only bot messages
    const sender = await event.message.getSender();
    if (!sender || !sender.bot) return;

    // Convert to Bot API format
    const chat = await event.message.getChat();
    const update = {
      update_id: event.message.id,
      message: {
        message_id: event.message.id,
        from: {
          id: sender.id,
          is_bot: sender.bot,
          first_name: sender.firstName || "",
          username: sender.username || undefined,
        },
        chat: {
          id: event.message.peerId.channelId || event.message.peerId.userId,
          type: event.message.isPrivate ? "private" : "supergroup",
          title: chat.title || undefined,
        },
        date: Math.floor(event.message.date / 1000),
        text: event.message.message,
      },
    };

    // Inject
    const response = await fetch("http://localhost:18789/telegram/inject", {
      method: "POST",
      headers: {
        Authorization: "Bearer your-secret-injection-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ update, accountId: "main" }),
    });

    console.log("Injected:", await response.json());
  },
  { chats: ["targetbot1", "targetbot2"] },
);

await client.start();
```

## Message Flow

```
External Bot → Telethon/GramJS
    ↓ (MTProto polling)
Your Filter Logic
    ↓ (convert to Bot API format)
POST /telegram/inject
    ↓ (authenticated)
OpenClaw Telegram Channel
    ↓ (bot.handleUpdate)
Full Message Processing Pipeline
    ↓
Agent Processing
    ↓
Reply (via Bot API)
```

## Security Considerations

- **Token security**: Keep `inject.token` secret; use a strong random value
- **Rate limiting**: Consider implementing rate limits in your external client
- **Validation**: OpenClaw validates the Update structure but trusts the content
- **Network**: Run on localhost or use HTTPS for remote deployments

## Troubleshooting

### "telegram inject not enabled"

Check config:

```bash
openclaw config get channels.telegram.accounts.main.inject.enabled
```

### "Unauthorized"

Verify the Bearer token matches `inject.token` in your config.

### "invalid update format"

Ensure your Update object matches Telegram Bot API format:

- `update_id` (number) is required
- At least one update type (`message`, `edited_message`, etc.) is required

### OpenClaw doesn't reply

Check that:

1. The bot is configured and running
2. The sender is in `allowFrom` (or pairing is enabled)
3. Group policy allows the message (if in a group)

### Debugging

Enable verbose logs:

```bash
OPENCLAW_VERBOSE=1 openclaw gateway run
```

Check gateway logs for injection requests and processing.

## Related

- [Telegram Channel Configuration](/channels/telegram)
- [Hooks System](/gateway/configuration#hooks)
- [Message Routing](/routing)
