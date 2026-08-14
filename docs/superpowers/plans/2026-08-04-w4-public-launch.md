# W4 — Public Launch on commissionwatch.bmux.sh

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Serve CommissionWatch at `https://commissionwatch.bmux.sh` from the shared `platform-aws` stack, allowlisted first, then public.

**Architecture:** The product joins the shared host's external `edge` and `internal` Docker networks. Caddy terminates TLS and reverse-proxies the subdomain to `commissionwatch-web`. Because the app needs pgvector and object storage that the shared platform does not provide, it runs its own Postgres and MinIO sidecars on `internal` — the same pattern `drift` uses for its Redis.

## Verified platform facts (probed 2026-08-04)

| Fact | Value |
|---|---|
| Host | `i-0123456789abcdef0`, t4g.medium, ARM, 2 vCPU / **4 GB**, AL2023 |
| Elastic IP | `184.34.114.153` |
| DNS | Route53 `Z0429816P70ENZXISB5B`, `*.bmux.sh` A → EIP. **`commissionwatch.bmux.sh` already resolves.** |
| Front door | Caddy 2.8-alpine, ACME HTTP-01, one site block per product |
| Shared DB | `postgres:15-alpine` — **no pgvector** |
| Networks | `edge` (Caddy ↔ web), `internal` (app ↔ data), both external |
| Port 22 | `184.166.213.70/32` only |
| Port 443 | `184.166.213.70/32` only — "one-line change when demos go public" |
| Port 80 | `0.0.0.0/0` — **must stay open** for ACME HTTP-01 |
| Deploy | Push to `platform-aws` main → Gitea Actions on runner `dh1` → SSH → compose up |

**Why the site errors today:** shared Caddy has no site block for `commissionwatch.bmux.sh`, so it aborts the TLS handshake on unknown SNI with `alert 80`. Adding the block is what makes a product live. This is documented platform behaviour, not a fault.

## Decisions

| Question | Decision |
|---|---|
| pgvector | Own `pgvector/pgvector:pg16` sidecar on `internal`. Does not touch the shared Postgres four live products depend on. |
| Object storage | Own MinIO sidecar on `internal`. |
| Exposure at launch | Allowlisted to `184.166.213.70/32` first. Open 443 only after the deployed site has been reviewed with real data. |
| Seed data in production | **Never run.** Seeds are development fixtures. Production data comes only from ingestion with provenance. |

## Blocking prerequisites — operator action required

These cannot be done by an agent and gate everything below.

1. **Gitea repo variable** on `your-org/commissionwatch`: `SHARED_STACK_LIVE = true`. Every product's `deploy-aws` job is gated on this.
2. **Gitea secret** `DEPLOY_ENV_FILE_AWS` on `your-org/commissionwatch`, containing at minimum:
   ```
   POSTGRES_PASSWORD=<generate: openssl rand -hex 32>
   MINIO_ROOT_PASSWORD=<generate: openssl rand -hex 32>
   CHANNEL_SECRET_KEY=<generate: openssl rand -hex 32>
   CI_EVENT_TOKEN=<generate: openssl rand -hex 32>
   DISCORD_WEBHOOK_URL=<the webhook>
   ```
3. **Explicit approval to push to `platform-aws` main**, since that push deploys production.

## Task 1: Confirm host headroom before adding three containers

**Files:** none — investigation.

- [ ] **Step 1:** Read current memory use on the host. The agent cannot SSH; ask the operator to run and paste:

```bash
ssh ec2-user@184.34.114.153 'free -m; docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}"'
```

- [ ] **Step 2:** CommissionWatch adds three containers — backend, Postgres+pgvector, MinIO — to a 4 GB host already running Caddy, Postgres, and four product stacks. Postgres alone defaults to a meaningful shared_buffers allocation.

  If free memory under 1.2 GB, do not proceed to Task 2. Instead set explicit limits: `shared_buffers=128MB`, `max_connections=20` on the product Postgres, `mem_limit` on all three services, and re-measure.

- [ ] **Step 3:** Record the measured numbers in this plan before continuing. Do not proceed on an assumption about headroom.

## Task 2: Product compose for the shared stack

**Files:** Create `deploy/docker-compose.shared.yml`

- [ ] **Step 1:** Write a compose file with four services on the external networks:
  - `commissionwatch-web` — the frontend image, on `edge` **and** `internal`, no host ports (Caddy reaches it over `edge`)
  - `commissionwatch-api` — backend, `internal` only
  - `commissionwatch-db` — `pgvector/pgvector:pg16`, `internal` only, named volume
  - `commissionwatch-minio` — MinIO, `internal` only, named volume

  Declare both networks `external: true`. No host port mappings on anything — the platform's other products bind none, and publishing a port here would expose a database on the public interface.

- [ ] **Step 2:** Set `mem_limit` on every service using the numbers measured in Task 1.

- [ ] **Step 3:** Verify locally that the file parses and that no service publishes a port:

```bash
docker compose -f deploy/docker-compose.shared.yml config | grep -A2 "ports:" && echo "PORTS FOUND - remove them" || echo "no published ports - correct"
```

- [ ] **Step 4:** Commit.

## Task 3: Caddy site block in platform-aws

**Files:** Modify `caddy/Caddyfile` in `your-org/platform-aws`

- [ ] **Step 1:** Add the block. Entries are kept alphabetical, so this goes **before** the `drift` block:

```
# commissionwatch — civic transparency dashboard. Express API + React SPA served
# by nginx on 3000. Runs its own Postgres (pgvector, which the shared
# postgres:15-alpine does not provide) and MinIO on `internal`; only the web
# container joins `edge`.
commissionwatch.bmux.sh {
	reverse_proxy commissionwatch-web:3000
}
```

- [ ] **Step 2:** Confirm the repo's CI guard passes — it fails the build on any reference to internal hosts:

```bash
grep -RniE 'docker-host-01|dh-1\b|ai2|internal-registry|builder\.internal|gitea\.internal' caddy/Caddyfile
```

Expected: no output.

- [ ] **Step 3:** **Stop. Get explicit operator approval before pushing** — a push to `platform-aws` main deploys the shared production stack.

- [ ] **Step 4:** After approval, push and watch the Gitea Actions run to completion.

- [ ] **Step 5:** Verify Caddy actually reloaded the new file rather than a cached inode. The platform README documents a real incident where the container served a four-hour-old Caddyfile while `caddy reload` exited 0. Confirm the route is live from outside:

```bash
curl -sS -o /dev/null -w "http=%{http_code}\n" https://commissionwatch.bmux.sh/
```

Expected before the product deploys: `502` — Caddy is routing but nothing is listening. That 502 is the success signal for this task, and proves TLS was issued.

## Task 4: Product deploy workflow

**Files:** Modify `.gitea/workflows/deploy.yml`

- [ ] **Step 1:** Add a `deploy-aws` job gated exactly as the other products are:

```yaml
if: vars.SHARED_STACK_LIVE == 'true'
```

- [ ] **Step 2:** Build and push both images to ECR, then SSH to the host and `docker compose -f docker-compose.shared.yml up -d`, writing `DEPLOY_ENV_FILE_AWS` to `.env` on the host first.

- [ ] **Step 3:** The images must be **ARM** — the host is `t4g.medium`, which is Graviton. An amd64 image will build fine in CI and fail to start on the host with `exec format error`. Set `platforms: linux/arm64` on the build.

- [ ] **Step 4:** Run migrations on startup, but **never seeds**. Confirm the entrypoint runs `npm run migrate` only.

- [ ] **Step 5:** Commit and push. Watch the run.

## Task 5: Verify the deployment from outside

- [ ] **Step 1:**

```bash
curl -sS -o /dev/null -w "http=%{http_code}\n" https://commissionwatch.bmux.sh/
curl -sS https://commissionwatch.bmux.sh/api/health
```

Expected: `200` on both, valid Let's Encrypt certificate.

- [ ] **Step 2:** Confirm the certificate is real and not self-signed:

```bash
openssl s_client -connect commissionwatch.bmux.sh:443 -servername commissionwatch.bmux.sh </dev/null 2>&1 | grep -E "issuer=|Verify return code"
```

- [ ] **Step 3:** Load every route in a browser and confirm no console errors and no blank pages.

- [ ] **Step 4:** Confirm the database is **empty of seed data** — no fictional officials, no real ones either, until ingestion runs:

```sql
SELECT count(*) FROM members;
```

Expected: `0`.

- [ ] **Step 5:** Confirm no database or MinIO port is reachable from outside:

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/184.34.114.153/5432' && echo "EXPOSED - fix immediately" || echo "closed - correct"
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/184.34.114.153/9000' && echo "EXPOSED - fix immediately" || echo "closed - correct"
```

## Task 6: Go public

**Only after the deployed site has been reviewed with real ingested data.**

- [ ] **Step 1:** Confirm with the operator that the site has been looked at and is fit to be public.

- [ ] **Step 2:** Operator opens 443 in security group `sg-05c9052b8df0b81d5` to `0.0.0.0/0`. Leave 22 restricted.

- [ ] **Step 3:** Verify from a network outside the allowlisted egress — a phone on cellular is sufficient.

- [ ] **Step 4:** Confirm `robots.txt`, sitemap, and Open Graph tags are served, per the launch-readiness spec.

## Definition of done

- `https://commissionwatch.bmux.sh/` returns 200 with a valid Let's Encrypt certificate
- `/api/health` returns 200
- No database or object-storage port is reachable from the internet
- The members table contains zero rows until ingestion populates it from sourced artifacts
- The site is reachable from a network outside the operator's egress
