/**
 * End-to-end tests for discord-message-proxy.ts.
 *
 * The proxy is spawned as a real subprocess (keeping the main script fully
 * self-contained) and pointed at a dummy in-process upstream that records
 * what it receives, so every assertion goes through the actual HTTP surface.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { SignJWT } from "npm:jose@6";

const SECRET = "test-signing-secret-0123456789";
const BOT_TOKEN = "real-bot-token";
const SIGNING_KEY = new TextEncoder().encode(SECRET);

interface UpstreamRequest {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  body: string;
}

/** Mint a JWT directly (bypassing /token) so we can craft expired/foreign tokens. */
async function mint(ch: string, expiresInSeconds: number, key: Uint8Array = SIGNING_KEY): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ch })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(key);
}

Deno.test({
  name: "discord-message-proxy",
  // The spawned proxy and its stdout drain outlive individual steps by design.
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  // Dummy upstream standing in for discord.com: records the request, replies 200.
  let lastUpstream: UpstreamRequest | null = null;
  const upstream = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    lastUpstream = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      auth: req.headers.get("authorization"),
      body: await req.text(),
    };
    return new Response(JSON.stringify({ upstream: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4" },
    });
  });

  // Spawn the proxy as a subprocess on a random port and wait for it to listen.
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", new URL("./discord-message-proxy.ts", import.meta.url).pathname],
    env: {
      DISCORD_BOT_TOKEN: BOT_TOKEN,
      SIGNING_SECRET: SECRET,
      UPSTREAM: `http://127.0.0.1:${upstream.addr.port}`,
      PORT: "0",
    },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  const stdout = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let port = 0;
  while (true) {
    const { value, done } = await stdout.read();
    if (done) throw new Error(`proxy exited before listening; output: ${buffered}`);
    buffered += value;
    const m = buffered.match(/listening on :(\d+)/);
    if (m) {
      port = Number(m[1]);
      break;
    }
  }
  // Keep draining stdout in the background so the child never blocks on a full pipe.
  (async () => {
    while (!(await stdout.read()).done) { /* discard */ }
  })().catch(() => {});

  const base = `http://127.0.0.1:${port}`;
  const CH = "123456789012345678";
  const OTHER = "999999999999999999";

  const api = (path: string, init: RequestInit = {}, token?: string) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bot ${token}` } : {}) },
    });

  const issue = (body: unknown) =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    await t.step("GET /healthz is unauthenticated", async () => {
      const res = await fetch(`${base}/healthz`);
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "ok\n");
    });

    await t.step("GET / serves the token-minting UI", async () => {
      const res = await fetch(base);
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
      assertStringIncludes(await res.text(), "discord-message-proxy");
    });

    await t.step("POST / is rejected", async () => {
      const res = await fetch(base, { method: "POST" });
      assertEquals(res.status, 405);
      await res.body?.cancel();
    });

    await t.step("POST /token rejects a wrong secret", async () => {
      const res = await issue({ secret: "wrong-secret", channels: CH, expiresIn: 3600 });
      assertEquals(res.status, 401);
      await res.body?.cancel();
    });

    await t.step("POST /token rejects malformed channels", async () => {
      for (const channels of ["", "abc", "123,abc", ",,,"]) {
        const res = await issue({ secret: SECRET, channels, expiresIn: 3600 });
        assertEquals(res.status, 400, `channels=${JSON.stringify(channels)}`);
        await res.body?.cancel();
      }
    });

    await t.step("POST /token rejects out-of-range expiresIn", async () => {
      for (const expiresIn of [0, 59, -1, 1.5, "3600", 1e12]) {
        const res = await issue({ secret: SECRET, channels: CH, expiresIn });
        assertEquals(res.status, 400, `expiresIn=${JSON.stringify(expiresIn)}`);
        await res.body?.cancel();
      }
    });

    await t.step("GET /token is rejected (POST only)", async () => {
      const res = await fetch(`${base}/token`);
      assertEquals(res.status, 405);
      await res.body?.cancel();
    });

    let issuedToken = "";
    await t.step("POST /token mints a JWT with the right secret", async () => {
      const res = await issue({ secret: SECRET, channels: ` ${CH} , ${OTHER} `, expiresIn: 3600 });
      assertEquals(res.status, 200);
      const data = await res.json();
      assertMatch(data.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
      assertMatch(data.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
      const payload = JSON.parse(atob(data.token.split(".")[1]));
      assertEquals(payload.ch, `${CH},${OTHER}`); // whitespace normalized away
      assert(typeof payload.exp === "number");
      issuedToken = data.token;
    });

    await t.step("proxies an allowed GET and swaps in the real bot token", async () => {
      const res = await api(`/api/v10/channels/${CH}/messages?limit=5`, {}, issuedToken);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { upstream: "ok" });
      assertEquals(res.headers.get("x-ratelimit-remaining"), "4"); // rate-limit headers relayed
      assertEquals(lastUpstream?.method, "GET");
      assertEquals(lastUpstream?.path, `/api/v10/channels/${CH}/messages`);
      assertEquals(lastUpstream?.search, "?limit=5");
      assertEquals(lastUpstream?.auth, `Bot ${BOT_TOKEN}`);
    });

    await t.step("accepts a bare token without the Bot prefix", async () => {
      const res = await fetch(`${base}/api/v10/channels/${CH}/messages`, {
        headers: { authorization: issuedToken },
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("proxies POST, PATCH, and DELETE message routes", async () => {
      const post = await api(`/api/v10/channels/${CH}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      }, issuedToken);
      assertEquals(post.status, 200);
      await post.body?.cancel();
      assertEquals(lastUpstream?.method, "POST");
      assertEquals(lastUpstream?.body, JSON.stringify({ content: "hi" }));

      const patch = await api(`/api/v10/channels/${CH}/messages/42`, { method: "PATCH" }, issuedToken);
      assertEquals(patch.status, 200);
      await patch.body?.cancel();

      const del = await api(`/api/v10/channels/${CH}/messages/42`, { method: "DELETE" }, issuedToken);
      assertEquals(del.status, 200);
      await del.body?.cancel();
      assertEquals(lastUpstream?.method, "DELETE");
      assertEquals(lastUpstream?.path, `/api/v10/channels/${CH}/messages/42`);
    });

    await t.step("refuses routes outside the message surface", async () => {
      const cases: [string, string][] = [
        ["POST", `/api/v10/channels/${CH}/messages/42`], // POST to a single message
        ["PATCH", `/api/v10/channels/${CH}/messages`], // PATCH the collection
        ["DELETE", `/api/v10/channels/${CH}/messages`], // bulk delete
        ["GET", `/api/v10/channels/${CH}`], // channel object
        ["PUT", `/api/v10/channels/${CH}/messages/42/reactions/x/@me`], // reactions
        ["GET", `/api/v10/users/@me`], // user routes
      ];
      for (const [method, path] of cases) {
        const res = await api(path, { method }, issuedToken);
        assertEquals(res.status, 403, `${method} ${path}`);
        await res.body?.cancel();
      }
    });

    await t.step("refuses channels outside the token's scope", async () => {
      const res = await api(`/api/v10/channels/424242424242424242/messages`, {}, issuedToken);
      assertEquals(res.status, 403);
      await res.body?.cancel();
    });

    await t.step("a wildcard token reaches any channel", async () => {
      const token = await mint("*", 3600);
      const res = await api(`/api/v10/channels/424242424242424242/messages`, {}, token);
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("rejects missing, garbage, expired, and foreign-signed tokens", async () => {
      const expired = await mint(CH, -3600);
      const foreign = await mint(CH, 3600, new TextEncoder().encode("another-secret-0123456789"));
      const tampered = issuedToken.slice(0, -2) + "xx";
      const attempts: (string | undefined)[] = [undefined, "garbage", expired, foreign, tampered];
      for (const token of attempts) {
        const res = await api(`/api/v10/channels/${CH}/messages`, {}, token);
        assertEquals(res.status, 401, `token=${token?.slice(0, 20)}`);
        await res.body?.cancel();
      }
    });
  } finally {
    child.kill();
    await child.status;
    await upstream.shutdown();
  }
});
