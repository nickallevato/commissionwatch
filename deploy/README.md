# CommissionWatch — Production Deployment

Production deployment config for the your-org multi-customer Caddy+Docker server (`your-org-multiproject-live`).

## Architecture

- **Caddy** terminates TLS and applies IP allowlist for `commissionwatch.legacy-platform.example`
- **Backend** (Node.js) serves the API on port 3001
- **Frontend** (Node.js) serves the dashboard on port 3000
- **PostgreSQL 16** with pgvector for data storage
- All containers on `caddy_net` Docker bridge network

## Deployment

These files get copied into the your-org infrastructure repo at `services/commissionwatch/`.

### Steps

1. CI automatically builds and pushes Docker images to ECR on merge to `main`.
2. To deploy, update the image tags in `.env` on the your-org repo:
   ```
   ECR_IMAGE_BACKEND=123456789012.dkr.ecr.us-west-2.amazonaws.com/your-org/commissionwatch-backend:<sha>
   ECR_IMAGE_FRONTEND=123456789012.dkr.ecr.us-west-2.amazonaws.com/your-org/commissionwatch-frontend:<sha>
   ```
3. Run the Ansible playbook from the your-org repo:
   ```bash
   ansible-playbook ansible/playbooks/deploy.yml -e service=commissionwatch
   ```

### On the server

Services live at `/opt/your-org/services/commissionwatch/` and are managed via `docker compose`.

## CI/CD

The Gitea Actions workflow (`.gitea/workflows/deploy.yml`) runs on push to `main`:
1. Lints and tests both backend and frontend
2. Builds Docker images tagged with git SHA + `latest`
3. Pushes to ECR

Required repository secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
