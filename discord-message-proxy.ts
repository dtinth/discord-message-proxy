#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * discord-message-proxy.ts — a narrow, token-swapping proxy for the Discord REST API.
 *
 * Point a client's Discord API base URL at this proxy instead of https://discord.com.
 * The client authenticates with a *client-facing* token; the proxy verifies it, checks
 * the request against that token's allowed channels, then swaps in the real bot token
 * before talking to Discord. The real bot token never leaves the machine running this.
 *
 *   client ──(Bot <AUTH token>)──▶ proxy ──(Bot DISCORD_BOT_TOKEN)──▶ discord.com
 *
 * Unlike a full pass-through, this proxy only permits **reading and posting messages**
 * in an explicit set of channels:
 *
 *   GET  /api/v{n}/channels/{id}/messages        list messages
 *   GET  /api/v{n}/channels/{id}/messages/{mid}  fetch one message
 *   POST /api/v{n}/channels/{id}/messages        post a message
 *
 * Everything else is refused with 403. Allowed requests are relayed untouched (paths,
 * query, body, rate-limit headers, status codes), so any Discord library or raw curl
 * works by only overriding the base URL.
 *
 * ── Config (env) ─────────────────────────────────────────────────────────────
 *   DISCORD_BOT_TOKEN   (required)  real bot token, used upstream toward Discord
 *   AUTH                (required)  client tokens and their allowed channels.
 *                                   One rule per line: "<token>@<chanId>,<chanId>,..."
 *                                   Use "*" to allow any channel. '#' lines ignored.
 *                                   Example:
 *                                     s3cr3t@123456789012345678,987654321098765432
 *                                     hunter2@*
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
 *     -e DISCORD_BOT_TOKEN=... -e AUTH='s3cr3t@123456789012345678' \
 *     denoland/deno:2.9.1 run --allow-net --allow-env \
 *     https://raw.githubusercontent.com/dtinth/discord-message-proxy/main/discord-message-proxy.ts
 */

import { createHash, timingSafeEqual } from "node:crypto";

const BOT_TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const GRANTS = parseAuth(requireEnv("AUTH"));
const UPSTREAM = (Deno.env.get("UPSTREAM") ?? "https://discord.com").replace(/\/+$/, "");
const DEFAULT_UA = Deno.env.get("DEFAULT_USER_AGENT") ??
  "DiscordBot (https://github.com/dtinth/discord-message-proxy, 1.0) discord-message-proxy";
const PORT = Number(Deno.env.get("PORT") ?? "8000");

// The only routes this proxy exposes: message list/fetch/create under a channel.
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

  // 1. Identify the client by its token (accepts "Bot <token>" or a bare token).
  const presented = (req.headers.get("authorization") ?? "").replace(/^Bot\s+/i, "").trim();
  const grant = presented ? findGrant(presented) : undefined;
  if (!grant) {
    log(`401 ${req.method} ${url.pathname} (bad client token)`);
    return json(401, { message: "proxy: unauthorized", code: 0 });
  }

  // 2. Enforce the narrow scope: only message read/post in the token's channels.
  if (!isAllowed(req.method, url.pathname, grant.channels)) {
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

// ── helpers ────────────────────────────────────────────────────────────────

interface Grant {
  hash: Uint8Array; // SHA-256 of the client token, precomputed for constant-time compare
  channels: Set<string>; // channel ids, or a single "*" meaning any channel
}

/** Return the grant whose token matches, comparing in constant time. */
function findGrant(presented: string): Grant | undefined {
  const h = sha256(presented);
  return GRANTS.find((g) => timingSafeEqual(g.hash, h));
}

/** Only message list/fetch (GET) and post (POST) within an allowed channel. */
function isAllowed(method: string, pathname: string, channels: Set<string>): boolean {
  const m = MESSAGE_ROUTE.exec(pathname);
  if (!m) return false;
  const [, channelId, singleMessage] = m;
  // GET works on both the collection and a single message; POST only on the collection.
  if (method === "GET") { /* ok */ }
  else if (method === "POST" && !singleMessage) { /* ok */ }
  else return false;
  return channels.has("*") || channels.has(channelId);
}

function parseAuth(raw: string): Grant[] {
  const grants: Grant[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf("@");
    if (at === -1) fatal(`AUTH: missing '@' in rule: ${t}`);
    const token = t.slice(0, at);
    if (!token) fatal(`AUTH: empty token in rule: ${t}`);
    const channels = new Set(
      t.slice(at + 1).split(",").map((c) => c.trim()).filter(Boolean),
    );
    if (channels.size === 0) fatal(`AUTH: no channels for token in rule: ${t}`);
    for (const c of channels) {
      if (c !== "*" && !/^\d+$/.test(c)) fatal(`AUTH: invalid channel id "${c}" in rule: ${t}`);
    }
    grants.push({ hash: sha256(token), channels });
  }
  if (grants.length === 0) fatal("AUTH: no rules configured");
  return grants;
}

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
