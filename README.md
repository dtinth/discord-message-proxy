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
call. A token can name individual channels, or [a whole server](#whole-server-tokens) with `<serverId>:*`.

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

`{id}` must be covered by the token's scope — named outright, inside a server the token allows, or `*`. Editing is
subject to Discord's own rule that a bot may only edit messages it authored; deleting other users' messages requires the
bot to have the Manage Messages permission. Everything else — reactions, guild/user routes, bulk delete — returns `403`.

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

Tokens are JWTs signed with `SIGNING_SECRET` (HS256) carrying:

- `ch` — the scope: a comma-separated list whose entries are each a channel ID (`123`), a whole server (`123:*` — see
  [Whole-server tokens](#whole-server-tokens)), or `*` for any channel the bot can see. Mixing is fine:
  `"456,789,123:*"`
- `bot` — which configured bot token to use (see [Multiple bots](#multiple-bots)); omitted means the default
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

`channels` is the scope list described above — channel IDs, `<serverId>:*` entries, `"*"`, or a mix; `expiresIn` is in
seconds (60 to 10 years). An optional `bot` field selects a [named bot](#multiple-bots) (omit it, or pass `""`, for the
default); an unknown name returns `400`. A wrong secret returns `401`.

## Whole-server tokens

A `<serverId>:*` entry grants message access to **every channel in that server**, including channels created after the
token was minted:

```sh
curl http://localhost:8000/token \
  -H 'Content-Type: application/json' \
  -d '{"secret": "your-signing-secret", "channels": "111111111111111111:*", "expiresIn": 604800}'
```

Discord's message routes carry only a channel ID, never a server ID, so the proxy can't tell from the request alone
which server a channel belongs to. When a request's channel isn't named literally in the token, the proxy asks Discord
(`GET /channels/{id}`, with that token's own bot credentials) and checks the `guild_id` it gets back. What that means in
practice:

- **One extra round trip, once per channel.** A channel can never move between servers, so a successful answer is cached
  for the process's lifetime; subsequent requests cost nothing. Tokens that name their channels literally never trigger
  a lookup at all, so nothing changes for them.
- **Threads are included.** Thread IDs resolve to their parent server, so a server-scoped token reaches threads in that
  server too.
- **DMs are never included.** A DM or group DM has no `guild_id`, so no `:*` entry can cover it.
- **A failed lookup fails the request.** If the channel is unknown or invisible to the bot, the proxy answers `403`; if
  the lookup itself can't be completed (network error, upstream `429`/`5xx`), it answers `502` and caches nothing. It
  never falls through to allowing the request.
- **Lookups are per-bot and rate-limited like any other call.** Cache entries are keyed by bot, since visibility differs
  between bots, and lookups draw on that bot's Discord rate-limit budget. Misses are cached briefly and the cache is
  size-bounded, so a client spraying random channel IDs can't amplify into unbounded upstream traffic.

`:*` is the only suffix form the proxy understands; anything else (`123:456`, `*:*`, a bare `:*`) is rejected at minting
time, and a token carrying an entry this version can't parse is refused outright with `401` rather than being quietly
narrowed.

## Multiple bots

If you run more than one Discord bot, register the extra ones as `DISCORD_BOT_TOKEN_<NAME>` — e.g.
`DISCORD_BOT_TOKEN_SUPPORT=...` registers a bot named `SUPPORT`, alongside the required `DISCORD_BOT_TOKEN` (the
default, unnamed one). A minted token is scoped to exactly one bot: the `bot` field at minting time picks which real
token the proxy swaps in, and that choice can't be changed later without minting a new token.

The web UI's minting form shows a **Bot** dropdown — populated from the unauthenticated `GET /bots` endpoint (which
lists configured names, never the secrets) — only when at least one named bot is configured; single-bot deployments see
the same form as before. If a bot is later removed from the environment, tokens that named it start failing with `401`
rather than silently falling back to the default.

## Configuration

All configuration is via environment variables.

| Variable              | Required | Default                             | Description                                                                                               |
| --------------------- | -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`   | ✅       | —                                   | The default real bot token, used upstream toward Discord.                                                 |
| `DISCORD_BOT_TOKEN_*` |          | —                                   | Additional named bot tokens — see [Multiple bots](#multiple-bots).                                        |
| `SIGNING_SECRET`      | ✅       | —                                   | HS256 shared secret for client JWTs, ≥ 16 chars. Whoever knows it can mint tokens for any channel or bot. |
| `UPSTREAM`            |          | `https://discord.com`               | Where to forward requests.                                                                                |
| `DEFAULT_USER_AGENT`  |          | a generic `DiscordBot (...)` string | UA sent upstream if the client didn't set one.                                                            |
| `PORT`                |          | `8000`                              | Listen port. (Deno Deploy sets this for you.)                                                             |

The signing secret is compared in constant time (SHA-256 + `timingSafeEqual`) when minting, and JWT verification is
handled by [jose](https://github.com/panva/jose).

## Deploy

### Deno Deploy

Push this file to a repo and point a Deno Deploy project at it, or deploy the raw URL directly. Set `DISCORD_BOT_TOKEN`
and `SIGNING_SECRET` as environment variables in the dashboard. Deno Deploy provides `PORT` automatically.

There's an unauthenticated `GET /healthz` endpoint returning `ok` for health probes. The token-minting UI at `GET /` is
also unauthenticated — minting itself requires the signing secret.

### Docker

A prebuilt multi-arch (`linux/amd64` + `linux/arm64`) image is published to GHCR on every push to `main`:

```sh
docker run -p 8000:8000 \
  -e DISCORD_BOT_TOKEN='your-real-bot-token' \
  -e SIGNING_SECRET='a-long-random-string-at-least-16-chars' \
  ghcr.io/dtinth/discord-message-proxy:latest
```

Or run the raw script in the stock Deno image, no build required:

```sh
docker run -p 8000:8000 \
  -e DISCORD_BOT_TOKEN='your-real-bot-token' \
  -e SIGNING_SECRET='a-long-random-string-at-least-16-chars' \
  denoland/deno:2.9.1 run --allow-net --allow-env \
  https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
```

## Companion tools

- [`tools/agent-bridge/`](./tools/agent-bridge/README.md) — `discord-agent-bridge.ts`, a completely independent,
  single-file CLI for reading and posting channel messages (send/edit/delete/read/monitor, NDJSON output), meant for
  agent harnesses and shell pipelines. It can talk straight to Discord or through a running proxy.

## Development

Each script (the proxy and every tool under `tools/`) stays a self-contained single file; tests live alongside it.

```sh
deno task tidy    # format
deno task check   # typecheck
deno task test    # end-to-end tests (spawns each script against a dummy upstream)
```

CI runs all three on every push and pull request.

## Notes & limitations

- **Server scope is resolved, not declared.** A `<serverId>:*` token makes authorization depend on a cached upstream
  lookup rather than on the request alone — see [Whole-server tokens](#whole-server-tokens) for the failure modes.
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
