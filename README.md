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
/agents    — AI agent configurations and prompts
/backend   — API server (FastAPI) and agent orchestrator
/frontend  — Public dashboard (Next.js)
/infra     — Docker, deployment, and infrastructure configs
/docs      — Product specs and documentation
```

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for frontend development)
- Python 3.11+ (for backend development)

### Quick Start

```bash
git clone https://github.com/nickallevato/commissionwatch.git
cd commissionwatch
docker compose up
```

The dashboard will be available at `http://localhost:3000`.

## Tech Stack

- **Agent Runtime:** Claude Code harness (zero-permission-first)
- **Backend:** Python / FastAPI
- **Database:** PostgreSQL + pgvector
- **Frontend:** Next.js
- **Deployment:** Docker Compose
- **License:** MIT

## Contributing

Contributions welcome! This is an open-source gift to the world. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
