# CommissionWatch

**AI-powered monitoring for real estate commission transparency.**

CommissionWatch tracks, analyzes, and surfaces real estate commission data to help consumers understand what they're actually paying. Built as a public-good tool following the NAR settlement reforms.

## Project Structure

```
/agents    — AI agent configurations and prompts
/backend   — API server and data pipeline
/frontend  — Web UI
/infra     — Docker, deployment, and infrastructure configs
```

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local development)

### Quick Start

```bash
git clone https://gitea.example.invalid/your-org/commissionwatch.git
cd commissionwatch
docker compose up
```

The app will be available at `http://localhost:3000`.

### Development

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Run in development mode
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
