#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * discord-message-proxy.ts — a narrow, token-swapping proxy for the Discord REST API.
 *
 * Point a client's Discord API base URL at this proxy instead of https://discord.com.
 * The client authenticates with a *client-facing* token; the proxy verifies it, checks
 * the request against that token's allowed channels, then swaps in the real bot token
 * before talking to Discord. The real bot token never leaves the machine running this.
 *
 *   client ──(Bot <JWT>)──▶ proxy ──(Bot DISCORD_BOT_TOKEN)──▶ discord.com
 *
 * Client tokens are **stateless JWTs** (HS256, signed with SIGNING_SECRET). Each token
 * carries its own channel scope and expiry, so granting access to a new channel is just
 * minting a new token — no config change, no redeploy. Mint tokens from the built-in
 * web UI at GET / (paste the signing secret, pick channels and a lifetime, copy the
 * token — or a ready-made prompt for an AI agent), or POST /token directly.
 *
 * Unlike a full pass-through, this proxy only permits **reading, posting, editing, and
 * deleting messages** in the token's allowed channels:
 *
 *   GET    /api/v{n}/channels/{id}/messages        list messages
 *   GET    /api/v{n}/channels/{id}/messages/{mid}  fetch one message
 *   POST   /api/v{n}/channels/{id}/messages        post a message
 *   PATCH  /api/v{n}/channels/{id}/messages/{mid}  edit a message (bot's own only)
 *   DELETE /api/v{n}/channels/{id}/messages/{mid}  delete a message
 *
 * Everything else is refused with 403. Allowed requests are relayed untouched (paths,
 * query, body, rate-limit headers, status codes), so any Discord library or raw curl
 * works by only overriding the base URL.
 *
 * ── Config (env) ─────────────────────────────────────────────────────────────
 *   DISCORD_BOT_TOKEN   (required)  real bot token, used upstream toward Discord
 *   SIGNING_SECRET      (required)  HS256 shared secret for client JWTs (≥ 16 chars).
 *                                   Whoever knows it can mint tokens for any channel.
 *   UPSTREAM            (optional)  default "https://discord.com"
 *   DEFAULT_USER_AGENT  (optional)  UA sent upstream if the client didn't set one
 *   PORT                (optional)  listen port (default 8000; Deno Deploy sets its own)
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   deno run --allow-net --allow-env discord-message-proxy.ts
 *   # or straight from a public URL, no checkout needed:
 *   deno run --allow-net --allow-env \
 *     https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
 *   # or via the stock image:
 *   docker run -p 8000:8000 \
 *     -e DISCORD_BOT_TOKEN=... -e SIGNING_SECRET='some-long-random-string' \
 *     denoland/deno:2.9.1 run --allow-net --allow-env \
 *     https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "npm:jose@6";

const BOT_TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const SIGNING_SECRET = requireEnv("SIGNING_SECRET");
if (SIGNING_SECRET.length < 16) fatal("SIGNING_SECRET must be at least 16 characters");
const SIGNING_KEY = new TextEncoder().encode(SIGNING_SECRET);
const SECRET_HASH = sha256(SIGNING_SECRET); // precomputed for constant-time compare in /token
const UPSTREAM = (Deno.env.get("UPSTREAM") ?? "https://discord.com").replace(/\/+$/, "");
const DEFAULT_UA = Deno.env.get("DEFAULT_USER_AGENT") ??
  "DiscordBot (https://github.com/dtinth/discord-message-proxy, 1.0) discord-message-proxy";
const PORT = Number(Deno.env.get("PORT") ?? "8000");

// Token lifetime must land between one minute and ten years.
const MIN_EXPIRES_IN = 60;
const MAX_EXPIRES_IN = 10 * 365 * 24 * 60 * 60;

// The only Discord routes this proxy exposes: message operations under a channel.
// Capture groups: (1) channel id, (2) optional "/<message id>" for single-message ops.
const MESSAGE_ROUTE = /^\/api\/v\d+\/channels\/(\d+)\/messages(\/\d+)?$/;

// Hop-by-hop request headers we must not forward, plus ones we set ourselves.
const STRIP_REQ = new Set(["host", "authorization", "content-length", "connection"]);
// Response headers that describe the wire encoding of the ORIGINAL body. Deno's
// fetch already decoded the body for us, so re-emitting these would corrupt it.
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

Deno.serve({ port: PORT, onListen: ({ port }) => log(`listening on :${port} → ${UPSTREAM}`) }, handler);

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Unauthenticated liveness check for the platform's health probe.
  if (url.pathname === "/healthz") return new Response("ok\n", { status: 200 });

  // Unauthenticated token-minting UI; minting itself requires the signing secret.
  if (url.pathname === "/") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(405, { message: "proxy: method not allowed", code: 0 });
    }
    return new Response(UI_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname === "/token") return issueToken(req);

  // 1. Identify the client by its JWT (accepts "Bot <jwt>" or a bare jwt).
  const presented = (req.headers.get("authorization") ?? "").replace(/^Bot\s+/i, "").trim();
  const channels = presented ? await verifyToken(presented) : undefined;
  if (!channels) {
    log(`401 ${req.method} ${url.pathname} (invalid or expired token)`);
    return json(401, { message: "proxy: unauthorized", code: 0 });
  }

  // 2. Enforce the narrow scope: only message ops in the token's channels.
  if (!isAllowed(req.method, url.pathname, channels)) {
    log(`403 ${req.method} ${url.pathname} (not permitted for this token)`);
    return json(403, { message: "proxy: route not allowed", code: 0 });
  }

  // 3. Rebuild the request toward Discord with the REAL bot token swapped in.
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!STRIP_REQ.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("authorization", `Bot ${BOT_TOKEN}`);
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_UA);

  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer(); // buffer the body; message payloads are small
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, init);
  } catch (err) {
    log(`502 ${req.method} ${url.pathname} (${err instanceof Error ? err.message : err})`);
    return json(502, { message: "proxy: upstream fetch failed", code: 0 });
  }

  // 4. Relay the response verbatim (rate-limit headers included), minus wire-encoding headers.
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    if (!STRIP_RES.has(k.toLowerCase())) out.set(k, v);
  }
  log(`${upstream.status} ${req.method} ${url.pathname}`);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ── token minting ──────────────────────────────────────────────────────────

/** POST /token {secret, channels, expiresIn} → {token, expiresAt}. */
async function issueToken(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { message: "proxy: method not allowed", code: 0 });

  let body: { secret?: unknown; channels?: unknown; expiresIn?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { message: "proxy: invalid JSON body", code: 0 });
  }

  if (typeof body.secret !== "string" || !timingSafeEqual(sha256(body.secret), SECRET_HASH)) {
    log("401 POST /token (bad signing secret)");
    return json(401, { message: "proxy: invalid signing secret", code: 0 });
  }

  const ch = normalizeChannels(body.channels);
  if (!ch) {
    return json(400, { message: 'proxy: channels must be comma-separated channel ids, or "*"', code: 0 });
  }

  const expiresIn = body.expiresIn;
  if (
    typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < MIN_EXPIRES_IN ||
    expiresIn > MAX_EXPIRES_IN
  ) {
    return json(400, {
      message: `proxy: expiresIn must be an integer between ${MIN_EXPIRES_IN} and ${MAX_EXPIRES_IN} seconds`,
      code: 0,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ ch })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(SIGNING_KEY);
  const expiresAt = new Date((now + expiresIn) * 1000).toISOString();
  log(`token issued: channels=${ch} expires=${expiresAt}`);
  return json(200, { token, expiresAt });
}

/** Accept "123,456" or "*"; return the normalized claim string, or undefined if invalid. */
function normalizeChannels(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const t = input.trim();
  if (t === "*") return "*";
  const ids = t.split(",").map((c) => c.trim()).filter(Boolean);
  if (ids.length === 0 || !ids.every((c) => /^\d+$/.test(c))) return undefined;
  return ids.join(",");
}

// ── token verification ─────────────────────────────────────────────────────

/** Verify the JWT (signature + expiry) and return its channel scope, or undefined. */
async function verifyToken(token: string): Promise<Set<string> | undefined> {
  try {
    const { payload } = await jwtVerify(token, SIGNING_KEY, { algorithms: ["HS256"] });
    if (typeof payload.ch !== "string") return undefined;
    const channels = new Set(payload.ch.split(",").map((c) => c.trim()).filter(Boolean));
    return channels.size > 0 ? channels : undefined;
  } catch {
    return undefined;
  }
}

/** Only message list/fetch (GET), post (POST), edit (PATCH), and delete (DELETE)
 * within an allowed channel. */
function isAllowed(method: string, pathname: string, channels: Set<string>): boolean {
  const m = MESSAGE_ROUTE.exec(pathname);
  if (!m) return false;
  const [, channelId, singleMessage] = m;
  // GET works on the collection and a single message; POST only on the collection;
  // PATCH (edit) and DELETE only target a single message.
  if (method === "GET") { /* ok */ }
  else if (method === "POST" && !singleMessage) { /* ok */ }
  else if (method === "PATCH" && singleMessage) { /* ok */ }
  else if (method === "DELETE" && singleMessage) { /* ok */ }
  else return false;
  return channels.has("*") || channels.has(channelId);
}

// ── helpers ────────────────────────────────────────────────────────────────

function sha256(s: string): Uint8Array {
  return createHash("sha256").update(s).digest();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) fatal(`missing required env var ${name}`);
  return v;
}

function fatal(msg: string): never {
  console.error(`FATAL: ${msg}`);
  Deno.exit(1);
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── web UI ─────────────────────────────────────────────────────────────────
// A single static page: enter the signing secret, channel id(s), and a lifetime;
// the backend mints a JWT. No user data is interpolated server-side.

const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>discord-message-proxy</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --text: #1c2128; --muted: #667085;
    --border: #d8dde4; --accent: #4553c0; --accent-text: #ffffff;
    --field: #ffffff; --ok: #1a7f37; --err: #c62828; --code: #f0f2f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c; --card: #1d2229; --text: #e6e9ee; --muted: #98a2b3;
      --border: #333b47; --accent: #8d9af0; --accent-text: #14171c;
      --field: #14171c; --ok: #4ade80; --err: #f87171; --code: #14171c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h1 code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .95rem; }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.25rem 1.25rem 1.5rem; margin-bottom: 1.25rem;
  }
  label { display: block; font-weight: 600; font-size: .9rem; margin: 1rem 0 .3rem; }
  label:first-child { margin-top: 0; }
  .hint { font-weight: 400; color: var(--muted); }
  input, select {
    width: 100%; padding: .55rem .7rem; font: inherit; color: var(--text);
    background: var(--field); border: 1px solid var(--border); border-radius: 8px;
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button {
    font: inherit; font-weight: 600; padding: .55rem 1.1rem; border-radius: 8px;
    border: 1px solid transparent; background: var(--accent); color: var(--accent-text);
    cursor: pointer; margin-top: 1.25rem;
  }
  button:disabled { opacity: .6; cursor: wait; }
  button.copy {
    margin: .5rem 0 0; padding: .35rem .8rem; font-size: .85rem;
    background: transparent; color: var(--accent); border-color: var(--border);
  }
  textarea, input.mono {
    width: 100%; padding: .55rem .7rem; margin-top: .2rem; color: var(--text);
    background: var(--code); border: 1px solid var(--border); border-radius: 8px;
    font: .8rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  textarea { resize: vertical; }
  textarea:focus, input.mono:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .error { color: var(--err); margin-top: 1rem; font-size: .9rem; display: none; }
  .expires { color: var(--ok); font-size: .9rem; margin: 0 0 1rem; }
  #result { display: none; }
  footer { color: var(--muted); font-size: .85rem; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1><code>discord-message-proxy</code></h1>
  <p class="sub">Mint a channel-scoped access token. You need the proxy's signing secret.</p>

  <form class="card" id="form">
    <label for="channels">Channel ID(s) <span class="hint">— comma-separated, or <code>*</code> for any channel</span></label>
    <input id="channels" required autocomplete="off" spellcheck="false" placeholder="123456789012345678">

    <label for="secret">Signing secret</label>
    <input id="secret" type="password" required autocomplete="off" placeholder="the proxy's SIGNING_SECRET">

    <label for="expires">Token lifetime</label>
    <select id="expires">
      <option value="3600">1 hour</option>
      <option value="86400">1 day</option>
      <option value="604800" selected>7 days</option>
      <option value="2592000">30 days</option>
      <option value="7776000">90 days</option>
      <option value="31536000">1 year</option>
    </select>

    <button id="generate">Generate token</button>
    <p class="error" id="error"></p>
  </form>

  <section class="card" id="result">
    <p class="expires" id="expiresAt"></p>

    <label for="token">Token</label>
    <input id="token" class="mono" readonly spellcheck="false">
    <button class="copy" data-copy="token">Copy token</button>

    <label for="prompt">Prompt <span class="hint">— paste this into an AI agent to let it use the channel.
      The token's signature is masked on screen; click into the box to reveal it. Copying always includes it.</span></label>
    <textarea id="prompt" rows="14" readonly spellcheck="false"></textarea>
    <button class="copy" data-copy="prompt">Copy prompt</button>
  </section>

  <footer>
    Tokens are stateless JWTs verified by this proxy —
    <a href="https://github.com/dtinth/discord-message-proxy">source</a>.
  </footer>
</main>
<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };

var PROMPT_TEMPLATE = [
  "<discord_integration_info>",
  "You can read, post, edit, and delete messages in a Discord channel through a REST proxy.",
  "",
  "Proxy base URL: {{ORIGIN}}",
  "Allowed channel ID(s): {{CHANNELS}}",
  "Access token (expires {{EXPIRES}}):",
  "{{TOKEN}}",
  "",
  "The proxy speaks the plain Discord REST API — same paths, request/response bodies, and",
  "status codes as https://discord.com/api/v10 — but only the routes below are allowed.",
  "Authenticate every request with the header: Authorization: Bot <access token>",
  "",
  "Allowed routes:",
  "- GET    /api/v10/channels/{{CH}}/messages — list recent messages (query params like ?limit=50 work)",
  "- GET    /api/v10/channels/{{CH}}/messages/{messageId} — fetch a single message",
  "- POST   /api/v10/channels/{{CH}}/messages — send a message; JSON body like {\\"content\\": \\"hello\\"}",
  "- PATCH  /api/v10/channels/{{CH}}/messages/{messageId} — edit a message this bot sent",
  "- DELETE /api/v10/channels/{{CH}}/messages/{messageId} — delete a message",
  "",
  "Example:",
  "curl -X POST '{{ORIGIN}}/api/v10/channels/{{CH_EXAMPLE}}/messages' \\\\",
  "  -H 'Authorization: Bot {{TOKEN}}' \\\\",
  "  -H 'Content-Type: application/json' \\\\",
  "  -d '{\\"content\\": \\"hello\\"}'",
  "</discord_integration_info>",
].join("\\n");

// The full prompt (with the real token) lives only in these variables; the visible
// textarea holds the masked version until focused.
var promptFull = "";
var promptMasked = "";

/** Replace the JWT's signature segment with asterisks for on-screen display. */
function maskToken(token) {
  var parts = token.split(".");
  if (parts.length !== 3) return token;
  return parts[0] + "." + parts[1] + "." + "*".repeat(parts[2].length);
}

function buildPrompt(channels, token, expiresAt) {
  var ids = channels === "*" ? [] : channels.split(",");
  var ch = ids.length === 1 ? ids[0] : "{channelId}";
  var chExample = ids.length >= 1 ? ids[0] : "{channelId}";
  return PROMPT_TEMPLATE
    .replaceAll("{{ORIGIN}}", location.origin)
    .replaceAll("{{CHANNELS}}", channels === "*" ? "any channel the bot can see" : channels)
    .replaceAll("{{EXPIRES}}", expiresAt)
    .replaceAll("{{CH}}", ch)
    .replaceAll("{{CH_EXAMPLE}}", chExample)
    .replaceAll("{{TOKEN}}", token);
}

$("form").addEventListener("submit", async function (e) {
  e.preventDefault();
  var button = $("generate");
  var error = $("error");
  error.style.display = "none";
  $("result").style.display = "none";
  button.disabled = true;
  button.textContent = "Generating…";
  try {
    var channels = $("channels").value.replace(/\\s+/g, "");
    var res = await fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: $("secret").value,
        channels: channels,
        expiresIn: Number($("expires").value),
      }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || "request failed (HTTP " + res.status + ")");
    $("expiresAt").textContent = "Token generated — expires " + data.expiresAt;
    $("token").value = data.token;
    promptFull = buildPrompt(channels, data.token, data.expiresAt);
    promptMasked = buildPrompt(channels, maskToken(data.token), data.expiresAt);
    $("prompt").value = promptMasked;
    $("result").style.display = "block";
  } catch (err) {
    error.textContent = err.message;
    error.style.display = "block";
  } finally {
    button.disabled = false;
    button.textContent = "Generate token";
  }
});

// Reveal the real token while the prompt is focused; re-mask on blur.
$("prompt").addEventListener("focus", function () {
  if (promptFull) this.value = promptFull;
});
$("prompt").addEventListener("blur", function () {
  if (promptMasked) this.value = promptMasked;
});

document.querySelectorAll("button.copy").forEach(function (btn) {
  btn.addEventListener("click", async function () {
    // The prompt textarea may be showing the masked version — always copy the full one.
    var text = btn.dataset.copy === "prompt" && promptFull ? promptFull : $(btn.dataset.copy).value;
    await navigator.clipboard.writeText(text);
    var original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(function () { btn.textContent = original; }, 1200);
  });
});
</script>
</body>
</html>
`;
