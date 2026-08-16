# Security review of the public surface — 2026-08-16

**Written during the third autonomous loop**, at the operator's instruction to "review code for
security and test coverage to ensure we have a secure and trustworthy public facing platform."

Every finding below was **probed against production** or read from the code, and the evidence is
included so each one can be re-checked rather than believed. Nothing here was taken from an agent's
summary.

**Nothing found is exploitable for data exposure.** The three findings are a header-ownership
problem, a missing HSTS on one response class, and an availability exposure. The severities are
stated honestly rather than inflated — a security review that dresses up minor findings makes the
serious one harder to see next time.

---

## Findings

### 1. Two layers both set security headers, and they disagree — *moderate*

`GET /api/health` returns **duplicated and conflicting** security headers:

```
x-frame-options: SAMEORIGIN
x-frame-options: DENY
referrer-policy: no-referrer
referrer-policy: strict-origin-when-cross-origin
content-security-policy: ... frame-ancestors 'self'; ...
content-security-policy: ... frame-ancestors 'none'; ...
server: Caddy
server: nginx/1.31.3
```

Two `Server` headers means two things are answering: the edge (Caddy) and something behind it
(nginx), **and** Express's own Helmet middleware. Each sets its own policy, and nobody owns the
result.

**Why it matters more than duplication normally would.** The two `X-Frame-Options` values are
*different*. RFC 7034 does not define behaviour for conflicting values, and browsers have historically
resolved this inconsistently — including by **ignoring the header entirely**. The practical risk today
is low, because the two CSPs both specify `frame-ancestors` and a browser enforces the intersection,
giving `'none'` — modern browsers use CSP over XFO anyway. So clickjacking is currently blocked.

The real defect is structural: **a policy nobody owns drifts.** Today the intersection happens to be
strict. A future edit that relaxes one layer will silently be overridden or silently take effect,
depending on which header and which browser, and no test in this repository would notice.

**Recommendation:** pick one layer as the owner of security headers — Helmet in the app is the
portable choice, since it travels with the code and is testable — and strip them at the edge. Then
assert the final header set in a test that fetches through the real stack.

### 2. HSTS is on `/api/*` but not on the HTML document — *low*

```
GET /                 → strict-transport-security absent
GET /api/health       → strict-transport-security: max-age=31536000; includeSubDomains
```

**The honest severity is low, not high, and the reason is worth stating** so this is neither ignored
nor over-fixed: HSTS is a *host*-scoped directive. Once any response from `commissionwatch.bmux.sh`
carries it, the browser pins the whole host. The SPA calls `/api/*` immediately on load, so a real
visitor gets pinned within a second of arriving.

The exposed window is genuinely narrow: the very first plain-HTTP navigation, before any API call.
That is not nothing — it is exactly the window a coffee-shop downgrade attack aims at — but it is not
"the site lacks HSTS."

**Recommendation:** set it at the edge for all responses. One line, no application change.

### 3. `/api/search` is unthrottled and uncached — *moderate, availability*

> **CORRECTED 2026-08-16, later the same day. The first sentence of this finding was wrong, and the
> method that produced it was wrong twice.**
>
> `/api/search` **was already rate limited** when this was written. `app.ts:97` applies
> `publicRateLimit` as global middleware, with `/api/search` and `/api/data` on a 60/min expensive
> tier and everything else on 600/min. It was added in `ad83ffa`, *"bound the public API"*, which
> predates this review.
>
> Two mistakes produced the false finding, and both are worth naming because either alone would
> have been enough:
>
> 1. **I grepped for the wrong symbol.** The search was for `FixedWindowLimiter`, the class, which
>    appears only in `disputes.ts` and `mcp.ts`. The middleware that wires it to the public surface
>    is `publicRateLimit`, and a grep for the implementation missed the caller.
> 2. **The probe could not have detected the limit it was testing for.** Twelve consecutive requests
>    were sent against a **sixty**-per-minute ceiling and all returned 200. That result is exactly
>    what a working limiter produces. Reporting "unthrottled" from it was reading a negative result
>    from a test with no power to find the thing.
>
> **What was genuinely missing** and has since been added: `Cache-Control` on `/api/search`
> responses, environment configurability of the limits, and a 429 body that points a throttled
> searcher at the bulk export rather than only refusing.
>
> The caching half of the original finding stands. The throttling half did not, and a security
> review that reports a defence as absent is not a harmless error — it invites someone to build the
> defence twice, and it discredits the findings beside it that were true.


The rate limiter (`services/rate-limit.ts`) is applied in exactly two places:

- `services/disputes.ts` — hourly and daily limits on dispute submission
- `routes/mcp.ts` — `MCP_RATE_LIMIT`

**No public read endpoint is rate limited.** Twelve consecutive requests to `/api/search?q=test`
returned twelve 200s.

Caching is inconsistent across the expensive endpoints:

| Endpoint | `cache-control` | Note |
|---|---|---|
| `/api/data/*.csv` | `public, max-age=300` | Cacheable; repeated dataset builds are absorbed |
| `/api/search?q=` | **absent** (ETag only) | Every distinct query reaches Postgres full-text |
| `/api/meetings` | absent (ETag only) | Cheaper query |

An ETag saves bandwidth on a *repeat* of the same query; it does not save the database from a stream
of *different* ones. `/api/search` runs `websearch_to_tsquery` against the corpus with no throttle
and no cache.

**Why this is worth more than the usual "add a rate limit" note.** Per `docs/superpowers/plans/2026-08-04-w4-public-launch.md`,
this deployment shares a 4 GB host with Caddy, Postgres, and four other product stacks. The blast
radius of an unthrottled full-text endpoint is therefore **the operator's other products**, not just
this one. That changes it from a self-inflicted availability risk into a neighbour-affecting one.

**Recommendation, and the tension in it:** a public transparency site should be generous to
researchers and hostile to nobody. A limit high enough to be invisible to a human and a scripted
bulk-downloader alike (the open-data export exists precisely so bulk users do not need to crawl) plus
a short `cache-control` on search would close this without changing what anyone can obtain. **This
was not implemented in this loop** — picking the number is a judgement about legitimate use that
belongs to the operator, and a limit set too low on a transparency site is its own kind of failure.

---

## Checked and found sound

Recorded so the next reviewer does not spend the time again.

- **CORS is not exploitable.** `access-control-allow-credentials: true` appears on
  `/api/admin/features`, which looks alarming alone — but the endpoint returns **no**
  `access-control-allow-origin`, including when probed with `Origin: https://evil.example`, so a
  browser blocks the response and the credentials header is inert. The public API returns
  `access-control-allow-origin: *`, which is correct for open data and cannot be combined with
  credentials by specification. **Probed both ways.**
- **No stack traces, paths, or internals in errors.** `/api/meetings/not-a-uuid` returns
  `{"error":"Invalid meeting ID format","statusCode":400}`. Malformed JSON returns the parser's
  position message and nothing else.
- **Session cookies are correct.** `httpOnly: true`, `secure` defaulting to `NODE_ENV === 'production'`,
  `sameSite: 'lax'`, `path: '/'`, an idle expiry — and the token is deliberately **not** echoed in the
  response body, with a comment saying why: "readable by any script on the page, which is the whole
  reason this is not a JWT in local storage." `lax` is adequate here because every admin mutation is
  a POST, which `lax` does not send cross-site.
- **Sign-in does not leak account existence.** One 401 body for unknown address, wrong password and
  locked account alike, with the reasoning in a comment.
- **No secret file was ever committed.** `git log --all --diff-filter=A` across the entire history
  matches no `.env`, `.pem`, `.key`, `id_rsa` or `credentials` path.
- **The CSP is genuinely strict**: `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, no
  `unsafe-eval`. `style-src` allows `unsafe-inline`, which is ordinary for a Tailwind build and not
  a script-execution vector.
- **The rate limiter collects no personal data**, deliberately — its docblock explains that keeping a
  row per submitter would mean collecting a fourth piece of personal information from someone filing
  a dispute.

## Minor notes, not findings

- `server: nginx/1.31.3` discloses an exact version. Low value to an attacker given everything else
  here, but it is free to suppress.
- `SESSION_COOKIE_SECURE=false` can force `secure` off in production. It requires a deliberate
  setting and exists for local HTTP development, but it is a footgun with no guard: nothing warns if
  it is set to `false` while `NODE_ENV === 'production'`. A one-line refusal at startup would close
  it.

---

## What was not tested, and why

Stated so this review is not read as broader than it is.

- **No authenticated testing of the admin console.** This loop holds no operator credentials, so
  everything behind the session cookie — the review queue, the feature registry, the pressroom — was
  probed only for its 401. Authorisation *within* an authenticated session is unreviewed.
- **No dependency vulnerability audit.** `npm audit` was not run against either package.
- **No load testing.** Finding 3 is reasoned from the code path and the host's documented sizing, not
  from a measured degradation. **It should not be cited as a measured limit.**
- **No penetration testing of the ingestion path.** Adapters fetch untrusted third-party HTML and
  PDFs; that parsing surface was not reviewed here.
