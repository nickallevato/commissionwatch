# CommissionWatch — Status, Gaps and Next Steps

> Last updated: 2026-08-05, after first production deploy.
> Read this before starting work. It records what is true, not what was planned.

## Live state

**https://commissionwatch.bmux.sh returns 200.** Verified from outside the host, with a valid Let's Encrypt certificate.

| | |
|---|---|
| Host | `i-0123456789abcdef0`, shared `*.bmux.sh` platform, t4g.medium (arm64), 4 GB |
| Containers | `commissionwatch-web`, `-backend`, `-db` (pgvector pg16), `-minio` — all healthy |
| Footprint | ~144 MB actual against 1408 MB of declared limits |
| Deploy dir | `/home/ec2-user/commissionwatch` on the host |
| Access | Gated at the Caddy layer to `184.166.213.70`. Everyone else gets 403 |
| Data | **Empty.** `members`, `meetings`, `votes` all zero rows |

### The site has no data in it

This is the single most important thing to understand. It is a working, well-built shell. The Gallatin adapter exists and passes 68 tests, but **nothing schedules it**, so no public record has ever been ingested. Making that true is the highest-value next task.

### The running deployment was done by hand

`deploy-aws` in CI has **never completed successfully**. The live containers were started manually over SSH on 2026-08-05. CI's own path is unproven end to end, so there is drift risk: the next CI deploy is also the first real test of it. Treat a green pipeline with suspicion until one full CI deploy has been observed working.

## Operational facts

Learned the hard way; each cost a failed deploy.

- **ECR repositories are `your-org/` prefixed** — `your-org/commissionwatch-backend`, `your-org/commissionwatch-frontend`. The CI user's IAM policy scopes to `repository/your-org/commissionwatch-*`, so an unprefixed path is denied. ECR reports both a wrong path and a missing repository as **403 on a blob HEAD**, never a 404, and never names the repository — so a 403 means check the path first, not the credentials.
- **Images must be `linux/arm64`.** The host is Graviton. An amd64 image builds cleanly and dies at startup with `exec format error`.
- **The host's instance role needed `ecr:BatchGetImage` on `your-org/*`.** The other products' repos are unprefixed, so `bmux-platform-host-ecr-pull` never covered ours. Fixed 2026-08-05 by adding that ARN pattern.
- **`ec2-user` cannot write to `/opt`.** `platform-aws` deploys to `/opt/platform-aws`, which must have been root-provisioned out of band. We deploy under `$HOME` instead, so no manual step is required per product.
- **Gitea `act_runner` runs jobs inside containers**, so a `services:` database answers to its service name (`postgres`), not `localhost`. The workflow probes both.
- **`actions/setup-node` had a corrupt runner cache**, failing with an `lstat` error naming a file from the action's own repo. Replaced with `container: node:22-bookworm`.
- **CI is Gitea Actions only.** Never add `.github/workflows/` — it does not run.
- **`POSTGRES_PASSWORD` is fixed at volume initialisation.** Changing the secret later will not change the database; rotation is an `ALTER ROLE` on the running instance.
- **SSM works on the host** (`AmazonSSMManagedInstanceCore` attached 2026-08-04), so `aws ssm send-command` can inspect or repair it without SSH.
- **Deploy key**: `~/.ssh/commissionwatch_deploy` on the operator workstation, public half in the host's `authorized_keys`, private half stored as the Gitea secret `PLATFORM_AWS_SSH_KEY`.

### Going public

Delete the two `@blocked` lines from the `commissionwatch.bmux.sh` block in `your-org/platform-aws`'s `caddy/Caddyfile`. **Do not** change the security group — its 443 allowlist is shared with seven other products, so opening it exposes all of them at once. Per-product exposure belongs in Caddy.

## Gaps — what is not built

Ordered by how much each blocks the product being real.

1. **Nothing ingests.** The queue, worker and Gallatin adapter exist; no scheduler runs them. Zero records on the live site.
2. **W3 findings engine and review queue.** The core product. Generated narrative, mechanical claim-to-citation binding, operator approval before anything naming a person publishes. Not started. Spec exists in the production design.
3. **Bozeman adapter.** Route identified and validated: `bozeman.granicus.com/ViewPublisher.php?view_id=1` carries **520 City Commission meetings spanning 2013–2026**, 507 with agendas, 434 with minutes. `bozemanmt.gov` is a blanket Akamai deny and must not be retried. Operator decision 2026-08-04: crawl Granicus politely and publish the public-records-request route alongside. See `docs/exploration/bozeman-access-spike.md`.
4. **MT CERS campaign finance** (`cers-ext.mt.gov/CampaignTracker`). Not started.
5. **W6 funding network layer.** Specced only — `docs/superpowers/specs/2026-08-04-funding-network-layer-design.md`.
6. **W7 delivery channels.** Specced only. Discord webhook posting works ad hoc; the in-app channel/routing/encryption layer is not built.
7. **Launch readiness**: corrections and dispute policy, public data export and licensing, backups with a tested restore, accessibility and shareability. Specced only.
8. **No database backups.** Nothing is backed up today. Once ingestion runs, this becomes urgent.
9. **No monitoring.** Nothing alerts if the site goes down or ingestion silently stops.
10. **No admin authentication.** Required before the review queue can exist.

## Known defects and debt

- **CI `deploy-aws` unverified.** See above.
- **Deploy pattern is push-based SSH** — long-lived key in CI, imperative rsync, secrets passed through CI. Better: secrets in SSM Parameter Store fetched by the host, and a pull-based rollout watching ECR. Worth doing before the pattern spreads to more products.
- **Homepage findings section is a placeholder constant** in `HomePage.tsx` with a TODO naming W3. It must not be filled with invented content about a real person.
- **`Layout.tsx` hardcodes "Last sweep 12 min ago."** Once real data exists this is a false statement on a transparency site. Wire it to the real sweep timestamp or remove it.
- **`meetings` has no `adjourned_at` or `meeting_type`.** `MeetingDetailPage` prints "Adjourned — Not recorded" verbatim.
- **No tests** for `MeetingDetailPage`, `StatusBadge`, `RundownViewer`.
- **`VoteBreakdown.tsx` may be unused** by any page — verify and delete or wire up.
- **W1 critic findings were never fully cleared.** An orchestration bug capped repairs at 5 of 19. The remaining ones were partly fixed incidentally. Re-run the critics rather than trusting the old list.

## Invariants — do not break these

Full detail in `.claude/skills/commissionwatch-development/SKILL.md`.

- No unsourced claim reaches the public site. `funding_edges.source_artifact_id` is `NOT NULL` for this reason.
- Nothing naming a person auto-publishes. It goes to the operator review queue.
- Seed data never names a real person, and **seeds never run in production** — the seed deletes every row first, so an automatic seed would destroy ingested records. `docker-entrypoint.sh` refuses to seed when `NODE_ENV=production`.
- Describe the record, never the motive. No assertion of intent, corruption or illegality.
- Detection logic applies identically to every entity class. No detector may filter on entity type to select targets.
- Never silence a type error; never delete a test to go green.
- The database schema is the source of truth for types.

## Next steps, in order

1. **Schedule Gallatin ingestion.** Wire the queue worker to a cron, run a sweep, confirm real meetings appear on the live site. This turns a shell into a civic-transparency site.
2. **Prove CI deploy end to end.** Run `deploy-aws` and watch it succeed, so the manual deployment is no longer the only path that has ever worked.
3. **Backups.** Postgres and MinIO snapshots with a restore that has actually been executed, before there is data worth losing.
4. **W3 findings engine and review queue**, with admin auth. The core product, and the highest-stakes component.
5. **Bozeman Granicus adapter**, plus the public-records-request page.
6. **Status page** reading `ingestion_runs`, so a silently stalled scraper is visible rather than reading as a quiet month at City Hall.
7. Then W5 correlation, W6 funding network, W7 delivery channels, and the launch-readiness work.

## For future agents

- Read `.claude/skills/commissionwatch-development/SKILL.md` first. It holds the process and the invariants.
- **Probe external sources before designing against them.** Every significant plan change in this project came from a `curl`, not from reasoning. Bozeman's real archive was found by following a DNS CNAME chain after HTTP probing dead-ended.
- **Verify by running commands.** Do not report success from an agent's claim or a green pipeline. Both have lied in this project.
- When fanning out, give agents disjoint file ownership and forbid concurrent git writes — a shared index lock corrupts work.
- A check that could not run is `blocked`, never `pass`.
