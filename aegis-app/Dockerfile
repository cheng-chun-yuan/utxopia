FROM oven/bun:1 AS base
WORKDIR /app

# --- Build SDK + App in one stage ---
FROM base AS builder

# Copy SDK source, install and build
COPY sdk /app/sdk
RUN cd /app/sdk && bun install && bun run build

# Copy app source and point @aegis/sdk to local build
COPY aegis-app /app/aegis-app
RUN cd /app/aegis-app && \
    sed -i 's|"@aegis/sdk": "[^"]*"|"@aegis/sdk": "file:../sdk"|' package.json && \
    bun install

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd /app/aegis-app && bunx next build --webpack

# --- Runtime ---
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/aegis-app/.next/standalone ./
COPY --from=builder /app/aegis-app/.next/static ./.next/static
COPY --from=builder /app/aegis-app/public ./public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["bun", "server.js"]
