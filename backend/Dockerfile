FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY knexfile.ts ./
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/knexfile.ts ./knexfile.ts
EXPOSE 3001
CMD ["node", "dist/src/index.js"]
