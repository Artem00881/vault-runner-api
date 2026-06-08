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

# Build/version traceability (audit F-059). Pass at build time:
#   --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg BUILD_TIME=$(date -u +%FT%TZ)
# Unset → "unknown" (behaviour identical to before this fix). Promoted to ENV so the
# running process (GET /version + the vaultrun_build_info metric) can read them, and
# stamped as the standard OCI revision label on the image.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
LABEL org.opencontainers.image.revision=$GIT_SHA

# Apply pending migrations, then start the server.
CMD ["sh", "-c", "bunx prisma migrate deploy && bun run src/main.ts"]
