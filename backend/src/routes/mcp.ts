import { Router, type Request, type Response } from "express";
import db from "../config/database";
import { FixedWindowLimiter } from "../services/rate-limit";
import { resolveFeature } from "../services/features/registry";
import {
  handleMcpMessage,
  mcpDiscoveryDocument,
  JSON_RPC_INVALID_REQUEST,
  MCP_LATEST_PROTOCOL_VERSION,
  type JsonRpcResponse,
} from "../services/delivery/mcp";

/**
 * `POST /mcp` and `GET /.well-known/mcp.json` — the machine channel.
 *
 * Delivery §"Two channels beyond the list" (b). The protocol, the tools and the
 * wall live in `services/delivery/mcp.ts`; this file is the HTTP end and holds
 * only what HTTP decides: the flag, the limiter, the method table and the
 * discovery path.
 *
 * ## ⛔ OFF unless an operator turns it on
 *
 * The `mcp_server` feature is resolved on every request and defaults to off,
 * exactly like `prerender` and `event_drain`. Off, both paths answer **404** —
 * not 503 and not "disabled", because "this site has no MCP endpoint" is the
 * true statement and a disabled-but-present endpoint is a surface somebody will
 * probe. Deploying this changes nothing an internet request can observe, which
 * is the point of shipping it dark and is verifiable in one curl.
 *
 * Read per request rather than captured at import so a test can flip it, and so
 * an operator's answer to "is it on?" is the switch rather than the uptime of
 * the process. `MCP_ENABLED=true` still enables it — see `mcpEnabled` below for
 * why that step keeps its own exact-string rule rather than the registry's.
 *
 * ## Paths
 *
 * Both are at the site root, not under `/api`, because that is where a client
 * looks: `/.well-known/` is defined by RFC 8615 to be at the root of an origin,
 * and an MCP endpoint is pasted into a config file by a human who will not guess
 * a prefix. **`frontend/nginx.conf` needs proxy locations for `/mcp` and
 * `/.well-known/mcp.json`** — the latter an exact match, ahead of the
 * `location ~* \.(txt|xml|json|csv|ics|map|webmanifest)$` regex block, which
 * would otherwise capture a `.json` path and serve it off the SPA's disk. That
 * is the trap the sitemap and the feeds each hit, and `nginx -t` is happy either
 * way; it has to be curled in a container. Serving nginx is outside this agent's
 * files, so until that lands the endpoint is reachable only inside the backend.
 */

const router = Router();

/**
 * One tool call fans out into the same work `/api/search` does, and `/api/search`
 * is in the expensive tier for that reason. This route is not under `/api`, so
 * `publicRateLimit`'s prefix table puts it in the default tier — 600 a minute,
 * which is a load generator's budget rather than a client's. Its own limiter,
 * with the expensive tier's number, is the honest fix; changing the shared table
 * from here would be this file editing a policy it does not own.
 */
const MCP_LIMIT = 60;
const MCP_WINDOW_MS = 60_000;

const limiter = new FixedWindowLimiter({ limit: MCP_LIMIT, windowMs: MCP_WINDOW_MS });

/** Exposed for the same reason `resetPublicRateLimits` is: cross-suite state. */
export function resetMcpRateLimit(): void {
  limiter.reset();
}

export const MCP_RATE_LIMIT = { limit: MCP_LIMIT, windowMs: MCP_WINDOW_MS } as const;

/**
 * The `mcp_server` switch, resolved per request against the in-process cache.
 *
 * Synchronous, because this sits on every request to `/mcp` and `/.well-known/`
 * and a promise has no business in that path — which is why `FeatureRegistry`
 * caches and polls rather than querying per read.
 *
 * **The legacy step keeps this file's own strictness.** The registry's generic
 * legacy reader accepts `1|true|yes|on`, matching what `EVENT_DRAIN_ENABLED` and
 * `PRERENDER_ENABLED` always accepted. `MCP_ENABLED` never did: it was an exact
 * `=== "true"`, and `test/mcp.test.ts` pins that with "404s on any value other
 * than the exact string true". Widening it here would turn `MCP_ENABLED=1` — a
 * value somebody has plausibly typed into a deploy config expecting it to be
 * inert — into a live public endpoint. So when the resolution says the legacy
 * variable is what decided, this call site re-reads its own variable by its own
 * rule. Every other step (kill switch, registry row, default) is the registry's
 * answer unchanged, and a registry row overrides the variable either way.
 */
export function mcpEnabled(): boolean {
  const resolution = resolveFeature("mcp_server");
  if (resolution.source === "legacy-env") return process.env.MCP_ENABLED === "true";
  return resolution.enabled;
}

/**
 * A citation that says `http://localhost:3000` is not a degraded citation, it is
 * a wrong one — and this channel exists so the citation survives the hop into
 * somebody else's context window, where nobody can repair it. Same rule, and the
 * same absent fallback, as `routes/sitemap.ts` and `routes/feed.ts`.
 */
function baseUrlOr503(res: Response): string | null {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl) {
    res.status(503).json({
      error: "MCP unavailable: PUBLIC_BASE_URL is not configured.",
      statusCode: 503,
    });
    return null;
  }
  return baseUrl.replace(/\/+$/, "");
}

function notFound(res: Response): void {
  res.status(404).json({ error: "Not found", statusCode: 404 });
}

function rateLimited(req: Request, res: Response): boolean {
  const decision = limiter.check(req.ip ?? "unknown");
  if (decision.allowed) return false;
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  res.status(429).json({
    error: "Too many requests",
    statusCode: 429,
    retryAfterSeconds: decision.retryAfterSeconds,
  });
  return true;
}

router.get("/.well-known/mcp.json", (req, res) => {
  if (!mcpEnabled()) {
    notFound(res);
    return;
  }
  if (rateLimited(req, res)) return;
  const baseUrl = baseUrlOr503(res);
  if (baseUrl === null) return;

  res
    .set("Cache-Control", "public, max-age=3600")
    .json(mcpDiscoveryDocument(baseUrl));
});

/**
 * Streamable HTTP, stateless.
 *
 * No session id is issued and none is required: every tool here is a pure read
 * that completes in one round trip, so a session would hold nothing. `GET /mcp`
 * — the SSE half of the transport, by which a server pushes to a client — is
 * therefore 405 rather than an idle stream a client would wait on forever.
 */
router.post("/mcp", (req, res, next) => {
  if (!mcpEnabled()) {
    notFound(res);
    return;
  }
  if (rateLimited(req, res)) return;
  const baseUrl = baseUrlOr503(res);
  if (baseUrl === null) return;

  const body: unknown = req.body;
  if (Array.isArray(body)) {
    // JSON-RPC batching was removed from MCP in 2025-06-18, and supporting it
    // would mean one request fanning into an unbounded number of searches
    // against one rate-limit token.
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: JSON_RPC_INVALID_REQUEST, message: "Batched requests are not supported" },
    });
    return;
  }

  handleMcpMessage(db, baseUrl, body)
    .then((response: JsonRpcResponse | null) => {
      if (response === null) {
        // A notification. JSON-RPC forbids a response body; 202 says it was
        // taken and there is nothing to say back.
        res.status(202).end();
        return;
      }
      res.set("MCP-Protocol-Version", MCP_LATEST_PROTOCOL_VERSION).json(response);
    })
    .catch(next);
});

router.get("/mcp", (req, res) => {
  if (!mcpEnabled()) {
    notFound(res);
    return;
  }
  res.set("Allow", "POST").status(405).json({
    error: "This MCP endpoint is stateless: POST a JSON-RPC request. There is no event stream.",
    statusCode: 405,
  });
});

router.delete("/mcp", (req, res) => {
  if (!mcpEnabled()) {
    notFound(res);
    return;
  }
  // Nothing to delete. There is no session.
  res.set("Allow", "POST").status(405).json({ error: "No session to end", statusCode: 405 });
});

export default router;
