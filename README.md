# CommissionWatch

**AI-powered civic transparency.**

CommissionWatch is an open-source, AI agent-powered platform for monitoring local government commissions. Pre-built watchdog agents auto-generate meeting rundowns, track voting patterns, follow campaign money trails, and surface conflicts of interest — starting with Bozeman, MT and Gallatin County.

Built for citizens watching government. Not sold to government.

## Documentation

- [Product Spec](docs/spec/product-spec.md) — full vision, decisions, and phased roadmap
- [Architecture](docs/spec/architecture.md) — system design and tech stack
- [Agent Specs](docs/spec/agents.md) — detailed watchdog agent definitions

## Project Structure

```
/backend   — API server (Node.js / Express) and agent orchestrator
/frontend  — Public dashboard (React / Vite)
/deploy    — Production deployment configs and Ansible playbooks
/docs      — Product specs and documentation
```

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Node.js 22+ (for local development)

### Quick Start (Docker)

```bash
git clone https://github.com/nickallevato/commissionwatch.git
cd commissionwatch
docker compose up
```

Services:
- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:3001/api/health
- **MinIO Console:** http://localhost:9001 (commwatch / commwatch-secret)

### Local Development

```bash
# Backend
cd backend
npm install
cp .env.example .env  # configure DATABASE_URL
npm run migrate
npm run dev           # starts on :3001

# Frontend
cd frontend
npm install
npm run dev           # starts on :3000, proxies /api to :3001
```

## Deployment

### Docker Compose (Staging)

The `docker-compose.yml` at the project root brings up the full stack:

| Service    | Port | Description                       |
| ---------- | ---- | --------------------------------- |
| frontend   | 3000 | Nginx serving React SPA           |
| backend    | 3001 | Node.js API with Express          |
| db         | 5432 | PostgreSQL 16 + pgvector          |
| minio      | 9000 | S3-compatible document storage    |

```bash
docker compose up -d        # start all services
docker compose ps           # check health
docker compose logs -f      # tail logs
docker compose down         # stop and remove containers
```

Database migrations run automatically on backend startup via the entrypoint script.

### Production

See [deploy/README.md](deploy/README.md) for production deployment using Caddy, ECR, and Ansible.

## Tech Stack

- **Backend:** Node.js 22 / Express 5 / TypeScript
- **Database:** PostgreSQL 16 + pgvector
- **Frontend:** React 19 / Vite / TypeScript
- **Object Storage:** MinIO (S3-compatible)
- **Deployment:** Docker Compose / Nginx
- **CI:** GitHub Actions
- **License:** MIT

## Contributing

Contributions welcome! This is an open-source gift to the world. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
