# agent-core service. M0 has no build step: tsx runs the TypeScript sources.
FROM node:24-slim

ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/llm/package.json packages/llm/
COPY packages/store-postgres/package.json packages/store-postgres/
COPY packages/tools/package.json packages/tools/
COPY packages/webhooks/package.json packages/webhooks/
COPY apps/evals/package.json apps/evals/
COPY apps/service/package.json apps/service/
COPY mocks/fake-llm/package.json mocks/fake-llm/
COPY mocks/shop/package.json mocks/shop/
# tsx is a dev dependency and is needed at runtime, so install everything.
RUN pnpm install --frozen-lockfile --prod=false

COPY packages packages
COPY apps apps

# /data holds master.key; the node user must own it. `agent-core` runs the CLI inside the container.
RUN mkdir /data && chown node:node /data \
  && printf '#!/bin/sh\nexec node --import tsx /app/apps/service/src/cli/main.ts "$@"\n' > /usr/local/bin/agent-core \
  && chmod +x /usr/local/bin/agent-core

USER node
EXPOSE 7300
CMD ["node", "--import", "tsx", "apps/service/src/main.ts"]
