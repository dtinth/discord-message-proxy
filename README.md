# discord-message-proxy

A tiny, single-file proxy that lets a client **read, post, and edit messages in specific
Discord channels** — without ever handing it your real bot token.

The client authenticates to the proxy with its own *client-facing* token. The proxy
verifies it, checks the request against that token's allowed channels, then swaps in
the real bot token before forwarding to Discord. Your bot token stays on the machine
running the proxy.

```
client ──(Bot <AUTH token>)──▶ proxy ──(Bot DISCORD_BOT_TOKEN)──▶ discord.com
```

Any Discord library or plain `curl` works — just override the API base URL. Everything
on an allowed request (path, query, body, rate-limit headers, status codes) is relayed
untouched.

## Why

A bot token is all-powerful: whoever holds it can do anything the bot can, in every
server it's in. When you want to give some script, teammate, or serverless function the
ability to post to *one channel*, handing over the bot token is wildly over-scoped and
irrevocable-per-consumer. This proxy narrows that down to "read/post messages in these
channels," behind a per-client token you can rotate independently.

## What it allows

Regardless of channel, a token may only hit these routes:

| Method  | Route | Purpose |
| ------- | ----- | ------- |
| `GET`   | `/api/v{n}/channels/{id}/messages` | list messages |
| `GET`   | `/api/v{n}/channels/{id}/messages/{mid}` | fetch one message |
| `POST`  | `/api/v{n}/channels/{id}/messages` | post a message |
| `PATCH` | `/api/v{n}/channels/{id}/messages/{mid}` | edit a message |

`{id}` must be in the token's allowed channel set. Editing is subject to Discord's own
rule that a bot may only edit messages it authored. Everything else — deletes, reactions,
guild/user routes, posting to a message id — returns `403`.

## Quick start

```sh
DISCORD_BOT_TOKEN='your-real-bot-token' \
AUTH='s3cr3t@123456789012345678' \
deno run --allow-net --allow-env \
  https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
```

Then point a client at it:

```sh
curl http://localhost:8000/api/v10/channels/123456789012345678/messages \
  -H 'Authorization: Bot s3cr3t' \
  -H 'Content-Type: application/json' \
  -d '{"content": "hello from behind the proxy"}' \
  -X POST
```

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `DISCORD_BOT_TOKEN` | ✅ | — | Your real bot token, used upstream toward Discord. |
| `AUTH` | ✅ | — | Client tokens and their allowed channels (see below). |
| `UPSTREAM` | | `https://discord.com` | Where to forward requests. |
| `DEFAULT_USER_AGENT` | | a generic `DiscordBot (...)` string | UA sent upstream if the client didn't set one. |
| `PORT` | | `8000` | Listen port. (Deno Deploy sets this for you.) |

### `AUTH` format

One rule per line: `<token>@<channelId>,<channelId>,...`

- Use `*` in place of channel ids to allow **any** channel for that token.
- Blank lines and lines starting with `#` are ignored.
- Multiple lines = multiple independent client tokens, each with its own scope.

```
# a scoped token, limited to two channels
s3cr3t@123456789012345678,987654321098765432

# an unrestricted token (any channel)
hunter2@*
```

Tokens are compared in constant time (SHA-256 + `timingSafeEqual`). Malformed rules
(missing `@`, empty token, non-numeric channel id) cause the proxy to exit at startup
with a clear error rather than silently misbehaving.

Clients may present the token as either `Bot <token>` or a bare `<token>`.

## Deploy

### Deno Deploy

Push this file to a repo and point a Deno Deploy project at it, or deploy the raw URL
directly. Set `DISCORD_BOT_TOKEN` and `AUTH` as environment variables in the dashboard.
Deno Deploy provides `PORT` automatically.

There's an unauthenticated `GET /healthz` endpoint returning `ok` for health probes.

### Docker

```sh
docker run -p 8000:8000 \
  -e DISCORD_BOT_TOKEN='your-real-bot-token' \
  -e AUTH='s3cr3t@123456789012345678' \
  denoland/deno:2.9.1 run --allow-net --allow-env \
  https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
```

## Notes & limitations

- **Shared rate-limit budget.** All clients share the bot's Discord rate limits — the
  proxy relays Discord's rate-limit headers verbatim but does not isolate clients from
  each other.
- **Bodies are buffered in memory.** Fine for text messages; large file attachments are
  read fully before forwarding.
- **No CORS headers.** This is meant for server-to-server use, not direct browser calls.
- **Run it over TLS in production.** The client token travels in the `Authorization`
  header; terminate HTTPS at the proxy or a load balancer in front of it.

## License

[WTFPL](./LICENSE) — do what the fuck you want to.
