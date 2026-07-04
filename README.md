# discord-message-proxy

A tiny, single-file proxy that lets a client **read, post, edit, and delete messages in specific Discord channels** —
without ever handing it your real bot token.

The client authenticates to the proxy with a **stateless, channel-scoped JWT**. The proxy verifies its signature and
expiry, checks the request against the token's allowed channels, then swaps in the real bot token before forwarding to
Discord. Your bot token stays on the machine running the proxy.

```
client ──(Bot <JWT>)──▶ proxy ──(Bot DISCORD_BOT_TOKEN)──▶ discord.com
```

Because tokens are stateless (HS256, signed with a shared secret), **granting access to a new channel is just minting a
new token** — no config change, no redeploy. Mint tokens from the built-in web UI at `/`, or with a direct `POST /token`
call.

Any Discord library or plain `curl` works — just override the API base URL. Everything on an allowed request (path,
query, body, rate-limit headers, status codes) is relayed untouched.

## Why

A bot token is all-powerful: whoever holds it can do anything the bot can, in every server it's in. When you want to
give some script, teammate, AI agent, or serverless function the ability to post to _one channel_, handing over the bot
token is wildly over-scoped and irrevocable-per-consumer. This proxy narrows that down to "message operations in these
channels, until this date," behind a token you can mint in seconds.

## What it allows

Regardless of channel, a token may only hit these routes:

| Method   | Route                                    | Purpose           |
| -------- | ---------------------------------------- | ----------------- |
| `GET`    | `/api/v{n}/channels/{id}/messages`       | list messages     |
| `GET`    | `/api/v{n}/channels/{id}/messages/{mid}` | fetch one message |
| `POST`   | `/api/v{n}/channels/{id}/messages`       | post a message    |
| `PATCH`  | `/api/v{n}/channels/{id}/messages/{mid}` | edit a message    |
| `DELETE` | `/api/v{n}/channels/{id}/messages/{mid}` | delete a message  |

`{id}` must be in the token's allowed channel set. Editing is subject to Discord's own rule that a bot may only edit
messages it authored; deleting other users' messages requires the bot to have the Manage Messages permission. Everything
else — reactions, guild/user routes, bulk delete — returns `403`.

## Quick start

```sh
DISCORD_BOT_TOKEN='your-real-bot-token' \
SIGNING_SECRET='a-long-random-string-at-least-16-chars' \
deno run --allow-net --allow-env \
  https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
```

Open <http://localhost:8000/> — enter a channel ID, the signing secret, and a lifetime, and copy the minted token (or a
ready-made prompt you can paste into an AI agent, which includes the proxy URL, channel ID, token, and the list of
supported endpoints).

Then point a client at it:

```sh
curl http://localhost:8000/api/v10/channels/123456789012345678/messages \
  -H "Authorization: Bot $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content": "hello from behind the proxy"}' \
  -X POST
```

Clients may present the token as either `Bot <token>` or a bare `<token>`.

## Tokens

Tokens are JWTs signed with `SIGNING_SECRET` (HS256) carrying two things:

- `ch` — allowed channel IDs, comma-separated (e.g. `"123,456"`), or `"*"` for any channel
- `exp` — standard expiry; the proxy rejects expired tokens with `401`

There is no token store and no revocation list — a token is valid until it expires, or until you rotate `SIGNING_SECRET`
(which invalidates **all** outstanding tokens at once). Pick lifetimes accordingly.

### Minting via API

The web UI is a thin wrapper over this endpoint, which you can call directly:

```sh
curl http://localhost:8000/token \
  -H 'Content-Type: application/json' \
  -d '{"secret": "your-signing-secret", "channels": "123456789012345678", "expiresIn": 604800}'
# → {"token": "eyJ...", "expiresAt": "2026-07-11T00:00:00.000Z"}
```

`channels` is a comma-separated ID list or `"*"`; `expiresIn` is in seconds (60 to 10 years). A wrong secret returns
`401`.

## Configuration

All configuration is via environment variables.

| Variable             | Required | Default                             | Description                                                                                        |
| -------------------- | -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`  | ✅       | —                                   | Your real bot token, used upstream toward Discord.                                                 |
| `SIGNING_SECRET`     | ✅       | —                                   | HS256 shared secret for client JWTs, ≥ 16 chars. Whoever knows it can mint tokens for any channel. |
| `UPSTREAM`           |          | `https://discord.com`               | Where to forward requests.                                                                         |
| `DEFAULT_USER_AGENT` |          | a generic `DiscordBot (...)` string | UA sent upstream if the client didn't set one.                                                     |
| `PORT`               |          | `8000`                              | Listen port. (Deno Deploy sets this for you.)                                                      |

The signing secret is compared in constant time (SHA-256 + `timingSafeEqual`) when minting, and JWT verification is
handled by [jose](https://github.com/panva/jose).

## Deploy

### Deno Deploy

Push this file to a repo and point a Deno Deploy project at it, or deploy the raw URL directly. Set `DISCORD_BOT_TOKEN`
and `SIGNING_SECRET` as environment variables in the dashboard. Deno Deploy provides `PORT` automatically.

There's an unauthenticated `GET /healthz` endpoint returning `ok` for health probes. The token-minting UI at `GET /` is
also unauthenticated — minting itself requires the signing secret.

### Docker

```sh
docker run -p 8000:8000 \
  -e DISCORD_BOT_TOKEN='your-real-bot-token' \
  -e SIGNING_SECRET='a-long-random-string-at-least-16-chars' \
  denoland/deno:2.9.1 run --allow-net --allow-env \
  https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
```

## discord-agent-bridge

The repo also ships `discord-agent-bridge.ts` — a completely independent, single-file CLI for reading and posting
channel messages, designed for agent harnesses and shell pipelines. It talks straight to Discord with a bot token by
default, or through a running `discord-message-proxy` by overriding the API base with a proxy-minted JWT. The two
scripts don't share any code; `discord-agent-bridge.ts` just happens to speak the same REST surface the proxy exposes.

```sh
export DISCORD_TOKEN='bot-token-or-proxy-jwt'
export DISCORD_CHANNEL='123456789012345678'
export DISCORD_API='https://your-proxy.example/api/v10'   # optional; omit to talk to Discord directly

./discord-agent-bridge.ts
```

### Commands

| Command                                      | Description                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| _(none)_                                     | Print usage.                                                                                                                |
| `send [text...] [--file <path>]`             | Send a message. Text comes from the arguments, `--file`, or stdin, in that order of preference. Prints the created message. |
| `edit <messageId> [text...] [--file <path>]` | Edit a message this bot previously sent. Text sources same as `send`.                                                       |
| `delete <messageId>`                         | Delete a message. Prints `{"deleted":"<id>"}`.                                                                              |
| `read [--limit N] [--include-bots]`          | Fetch up to `N` recent messages once (default 50, max 100), oldest first.                                                   |
| `monitor [--include-bots]`                   | Poll for new messages forever, printing each as it arrives. Never exits.                                                    |

```sh
./discord-agent-bridge.ts send hello world      # text from args
echo "multi-line text" | ./discord-agent-bridge.ts send   # text from stdin
./discord-agent-bridge.ts send --file ./message.txt
./discord-agent-bridge.ts edit 123456789012345678 corrected text
./discord-agent-bridge.ts delete 123456789012345678
./discord-agent-bridge.ts read --limit 20
./discord-agent-bridge.ts monitor
```

### Environment

| Variable                | Required | Default                       | Description                                                                                            |
| ----------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`         | ✅       | —                             | Bot token or proxy-minted JWT; sent as `Authorization: Bot <token>`.                                   |
| `DISCORD_CHANNEL`       | ✅       | —                             | Channel id to operate on.                                                                              |
| `DISCORD_API`           |          | `https://discord.com/api/v10` | API base URL. Point this at a `discord-message-proxy` to use a scoped JWT instead of a real bot token. |
| `DISCORD_POLL_INTERVAL` |          | `20`                          | `monitor` poll interval, in seconds.                                                                   |

### Output

Output is NDJSON — exactly one line per message, with an ISO 8601 `timestamp`:

```json
{
  "id": "…",
  "timestamp": "2026-01-01T00:00:00.000000+00:00",
  "author": "name",
  "author_id": "…",
  "bot": false,
  "content": "hi"
}
```

`attachments` (an array of URLs) and `edited_timestamp` are added only when present. `read` and `monitor` skip messages
authored by bots (including this script's own messages) unless you pass `--include-bots`.

`monitor` remembers the newest message at startup — no backlog is ever printed — then emits each newer message as it
arrives, oldest first, retrying through transient failures (network errors, 5xx, rate limits) without exiting. The
one-line-per-message output is built to feed line-oriented watchers, such as this tool's own `Monitor` background-event
mechanism, without any parsing beyond `JSON.parse` per line.

## Development

The proxy itself stays a self-contained single file (`discord-message-proxy.ts`); tests live alongside it.

```sh
deno task tidy    # format
deno task check   # typecheck
deno task test    # end-to-end tests (spawns the proxy against a dummy upstream)
```

CI runs all three on every push and pull request.

## Notes & limitations

- **No revocation.** Stateless tokens can't be revoked individually; rotating `SIGNING_SECRET` invalidates every
  outstanding token.
- **Shared rate-limit budget.** All clients share the bot's Discord rate limits — the proxy relays Discord's rate-limit
  headers verbatim but does not isolate clients from each other.
- **Bodies are buffered in memory.** Fine for text messages; large file attachments are read fully before forwarding.
- **No CORS headers on API routes.** The proxy is meant for server-to-server use, not direct browser calls. (The minting
  UI is same-origin, so it needs none.)
- **Run it over TLS in production.** Tokens travel in the `Authorization` header and the signing secret in the
  `POST /token` body; terminate HTTPS at the proxy or a load balancer in front of it.

## License

[WTFPL](./LICENSE) — do what the fuck you want to.
