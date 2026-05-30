# Vault Run API — production image (Bun + NestJS + Prisma)
FROM oven/bun:1

WORKDIR /app

# Prisma query engine needs openssl at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies (cached layer).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Generate the Prisma client for this platform.
COPY prisma ./prisma
RUN bunx prisma generate

# App source.
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "bunx prisma migrate deploy && bun run src/main.ts"]
