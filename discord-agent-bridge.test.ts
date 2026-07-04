/**
 * End-to-end tests for discord-agent-bridge.ts.
 *
 * The CLI is spawned as a real subprocess against a dummy in-process Discord API,
 * so every assertion covers the actual argv/env/HTTP/NDJSON surface.
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const CHANNEL = "123456789012345678";
const TOKEN = "test-token";
const SCRIPT = new URL("./discord-agent-bridge.ts", import.meta.url).pathname;

interface StoredMessage {
  id: string;
  timestamp: string;
  edited_timestamp?: string | null;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  attachments: { url: string }[];
}

/** In-memory stand-in for the Discord message API, plus knobs for fault injection. */
class FakeDiscord {
  messages: StoredMessage[] = [];
  requests: { method: string; path: string; search: string; auth: string | null; body: string }[] = [];
  failNextGet = false;
  private nextId = 1000n;
  private server: Deno.HttpServer;

  constructor() {
    this.server = Deno.serve({ port: 0, onListen: () => {} }, (req) => this.handle(req));
  }

  get apiBase(): string {
    return `http://127.0.0.1:${(this.server.addr as Deno.NetAddr).port}/api/v10`;
  }

  /** Seed a message as if some user (or another bot) had posted it. */
  add(content: string, author: { username: string; bot?: boolean }): StoredMessage {
    const msg: StoredMessage = {
      id: String(this.nextId++),
      timestamp: new Date().toISOString(),
      content,
      author: { id: "42", ...author },
      attachments: [],
    };
    this.messages.push(msg);
    return msg;
  }

  async shutdown(): Promise<void> {
    await this.server.shutdown();
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      auth: req.headers.get("authorization"),
      body: req.method === "GET" ? "" : await req.text(),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    const collection = url.pathname === `/api/v10/channels/${CHANNEL}/messages`;
    const single = url.pathname.match(new RegExp(`^/api/v10/channels/${CHANNEL}/messages/(\\d+)$`));

    if (req.method === "GET" && collection) {
      if (this.failNextGet) {
        this.failNextGet = false;
        return json(500, { message: "injected failure" });
      }
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const after = url.searchParams.get("after");
      let result = [...this.messages];
      if (after) result = result.filter((m) => BigInt(m.id) > BigInt(after));
      result.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // newest first, like Discord
      return json(200, result.slice(0, limit));
    }
    if (req.method === "POST" && collection) {
      const body = JSON.parse(this.requests.at(-1)!.body);
      return json(200, this.add(body.content, { username: "bridge-bot", bot: true }));
    }
    if (req.method === "PATCH" && single) {
      const msg = this.messages.find((m) => m.id === single[1]);
      if (!msg) return json(404, { message: "Unknown Message" });
      msg.content = JSON.parse(this.requests.at(-1)!.body).content;
      msg.edited_timestamp = new Date().toISOString();
      return json(200, msg);
    }
    if (req.method === "DELETE" && single) {
      const idx = this.messages.findIndex((m) => m.id === single[1]);
      if (idx === -1) return json(404, { message: "Unknown Message" });
      this.messages.splice(idx, 1);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: "unhandled route" });
  }
}

/** Run the CLI to completion and capture its output. */
async function run(
  fake: FakeDiscord,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", SCRIPT, ...args],
    env: { DISCORD_TOKEN: TOKEN, DISCORD_CHANNEL: CHANNEL, DISCORD_API: fake.apiBase, ...opts.env },
    stdin: opts.stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const { code, stdout, stderr } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout), stderr: new TextDecoder().decode(stderr) };
}

function ndjson(stdout: string): Record<string, unknown>[] {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

Deno.test("bare invocation and help print usage", async () => {
  const fake = new FakeDiscord();
  try {
    const bare = await run(fake, []);
    assertEquals(bare.code, 0);
    assertStringIncludes(bare.stdout, "Usage:");
    assertStringIncludes(bare.stdout, "monitor");
    const unknown = await run(fake, ["frobnicate"]);
    assertEquals(unknown.code, 1);
    assertStringIncludes(unknown.stderr, "unknown command");
  } finally {
    await fake.shutdown();
  }
});

Deno.test("send: from arguments, --file, and stdin", async () => {
  const fake = new FakeDiscord();
  try {
    const fromArgs = await run(fake, ["send", "hello", "world"]);
    assertEquals(fromArgs.code, 0);
    const [rec] = ndjson(fromArgs.stdout);
    assertEquals(rec.content, "hello world");
    assertEquals(rec.bot, true);
    assert(typeof rec.id === "string");
    assert(typeof rec.timestamp === "string");
    const posted = fake.requests.find((r) => r.method === "POST");
    assertEquals(posted?.auth, `Bot ${TOKEN}`);
    assertEquals(JSON.parse(posted!.body), { content: "hello world" });

    const file = await Deno.makeTempFile({ suffix: ".txt" });
    await Deno.writeTextFile(file, "from a file\nsecond line\n");
    const fromFile = await run(fake, ["send", "--file", file]);
    assertEquals(fromFile.code, 0);
    assertEquals(ndjson(fromFile.stdout)[0].content, "from a file\nsecond line");

    const fromStdin = await run(fake, ["send"], { stdin: "from stdin\n" });
    assertEquals(fromStdin.code, 0);
    assertEquals(ndjson(fromStdin.stdout)[0].content, "from stdin");

    const empty = await run(fake, ["send"], { stdin: "" });
    assertEquals(empty.code, 1);
    assertStringIncludes(empty.stderr, "empty message");

    const both = await run(fake, ["send", "text", "--file", file]);
    assertEquals(both.code, 1);
    assertStringIncludes(both.stderr, "not both");
  } finally {
    await fake.shutdown();
  }
});

Deno.test("edit and delete round-trip", async () => {
  const fake = new FakeDiscord();
  try {
    const msg = fake.add("original", { username: "bridge-bot", bot: true });

    const edited = await run(fake, ["edit", msg.id, "fixed", "now"]);
    assertEquals(edited.code, 0);
    const [rec] = ndjson(edited.stdout);
    assertEquals(rec.content, "fixed now");
    assert(typeof rec.edited_timestamp === "string");

    const badId = await run(fake, ["edit", "not-an-id", "text"]);
    assertEquals(badId.code, 1);

    const deleted = await run(fake, ["delete", msg.id]);
    assertEquals(deleted.code, 0);
    assertEquals(ndjson(deleted.stdout)[0], { deleted: msg.id });
    assertEquals(fake.messages.length, 0);

    const missing = await run(fake, ["delete", "999999"]);
    assertEquals(missing.code, 1);
    assertStringIncludes(missing.stderr, "404");
  } finally {
    await fake.shutdown();
  }
});

Deno.test("read: oldest first, bot filtering, --limit", async () => {
  const fake = new FakeDiscord();
  try {
    fake.add("first", { username: "alice" });
    fake.add("beep", { username: "some-bot", bot: true });
    fake.add("second", { username: "bob" });

    const plain = await run(fake, ["read"]);
    assertEquals(plain.code, 0);
    assertEquals(ndjson(plain.stdout).map((r) => r.content), ["first", "second"]); // bots skipped, oldest first

    const withBots = await run(fake, ["read", "--include-bots"]);
    assertEquals(ndjson(withBots.stdout).map((r) => r.content), ["first", "beep", "second"]);

    // limit=2 keeps the two newest ("beep", "second"); the bot one is then filtered out
    const limited = await run(fake, ["read", "--limit", "2"]);
    assertStringIncludes(fake.requests.at(-1)!.search, "limit=2");
    assertEquals(ndjson(limited.stdout).map((r) => r.content), ["second"]);

    const badLimit = await run(fake, ["read", "--limit", "500"]);
    assertEquals(badLimit.code, 1);
  } finally {
    await fake.shutdown();
  }
});

Deno.test("monitor: emits only new non-bot messages and survives a failing poll", async () => {
  const fake = new FakeDiscord();
  fake.add("backlog — must not appear", { username: "alice" });

  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", SCRIPT, "monitor"],
    env: {
      DISCORD_TOKEN: TOKEN,
      DISCORD_CHANNEL: CHANNEL,
      DISCORD_API: fake.apiBase,
      DISCORD_POLL_INTERVAL: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const lines: string[] = [];
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const pump = (async () => {
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      lines.push(...parts.filter(Boolean));
    }
  })();
  const errPump = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
  const drainErr = (async () => {
    while (!(await errPump.read()).done) { /* discard */ }
  })();

  async function waitForLines(count: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (lines.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lines; got ${lines.length}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    // Give the monitor a moment to record its baseline, then post fresh messages.
    await new Promise((r) => setTimeout(r, 500));
    fake.add("new human message", { username: "alice" });
    fake.add("bot chatter — skipped", { username: "some-bot", bot: true });
    await waitForLines(1, 10_000);
    assertEquals(JSON.parse(lines[0]).content, "new human message");

    // A failed poll must not kill the loop.
    fake.failNextGet = true;
    fake.add("after the failure", { username: "bob" });
    await waitForLines(2, 10_000);
    assertEquals(JSON.parse(lines[1]).content, "after the failure");
    assertEquals(lines.length, 2); // backlog and bot messages never surfaced
  } finally {
    child.kill();
    await child.status;
    await pump.catch(() => {});
    await drainErr.catch(() => {});
    await fake.shutdown();
  }
});
