# agent-core service. M0 has no build step: tsx runs the TypeScript sources.
FROM node:24-slim

ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/adapters/llm-cassette/package.json packages/adapters/llm-cassette/
COPY packages/adapters/llm-openai/package.json packages/adapters/llm-openai/
COPY packages/adapters/store-postgres/package.json packages/adapters/store-postgres/
COPY packages/adapters/tools-mcp/package.json packages/adapters/tools-mcp/
COPY packages/adapters/tools-webhook/package.json packages/adapters/tools-webhook/
COPY packages/adapters/webhooks/package.json packages/adapters/webhooks/
COPY apps/evals/package.json apps/evals/
COPY apps/service/package.json apps/service/
COPY mocks/fake-llm/package.json mocks/fake-llm/
COPY mocks/shop/package.json mocks/shop/
# tsx is a dev dependency and is needed at runtime, so install everything.
RUN pnpm install --frozen-lockfile --prod=false

COPY packages packages
COPY apps apps

USER node
EXPOSE 7300
CMD ["node", "--import", "tsx", "apps/service/src/main.ts"]
