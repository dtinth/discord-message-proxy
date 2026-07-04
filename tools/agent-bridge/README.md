# discord-agent-bridge

A completely independent, single-file CLI for reading and posting Discord channel messages, designed for agent harnesses
and shell pipelines. It talks straight to Discord with a bot token by default, or through a running
[`discord-message-proxy`](../../README.md) by overriding the API base with a proxy-minted JWT. The two scripts don't
share any code; `discord-agent-bridge.ts` just happens to speak the same REST surface the proxy exposes.

```sh
export DISCORD_TOKEN='bot-token-or-proxy-jwt'
export DISCORD_CHANNEL='123456789012345678'
export DISCORD_API='https://your-proxy.example/api/v10'   # optional; omit to talk to Discord directly

./discord-agent-bridge.ts
```

## Commands

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

## Environment

| Variable                | Required | Default                       | Description                                                                                            |
| ----------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`         | ✅       | —                             | Bot token or proxy-minted JWT; sent as `Authorization: Bot <token>`.                                   |
| `DISCORD_CHANNEL`       | ✅       | —                             | Channel id to operate on.                                                                              |
| `DISCORD_API`           |          | `https://discord.com/api/v10` | API base URL. Point this at a `discord-message-proxy` to use a scoped JWT instead of a real bot token. |
| `DISCORD_POLL_INTERVAL` |          | `20`                          | `monitor` poll interval, in seconds.                                                                   |

## Output

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
one-line-per-message output is built to feed line-oriented watchers without any parsing beyond `JSON.parse` per line.

## Best practices

This tool is meant for looping teammates into a session over Discord — e.g. an agent that wants a second opinion or a
heads-up from someone not in the room. When used that way, an agent should:

- **Greet on `monitor` startup** — send a message like "You can type here — I'm watching this channel now" before going
  quiet, so people know it's safe to type.
- **Acknowledge before working** — when a message arrives, reply briefly with what you understood and what you'll do
  next, _before_ starting. For long-running work, that first reply isn't the answer — send a second one once the work is
  actually done.
- **Say goodbye on `monitor` exit** — send a farewell like "No longer monitoring this channel" so people don't keep
  typing expecting a reply.

Running the script with no arguments prints this same guidance as part of its usage text.

## Development

Tests live alongside the script in this folder and run as part of the repo-wide `deno task check` / `deno task test`
(see the [top-level README](../../README.md#development)).
