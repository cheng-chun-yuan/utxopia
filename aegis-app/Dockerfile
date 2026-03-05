FROM oven/bun:1 AS base
WORKDIR /app

# --- Build SDK + App in one stage ---
FROM base AS builder

# Copy SDK source, install and build
COPY sdk /app/sdk
RUN cd /app/sdk && bun install && bun run build

# Copy app source and install deps
COPY aegis-app /app/aegis-app
RUN cd /app/aegis-app && bun install

# Override npm @aegis/sdk with local built SDK (AFTER bun install)
RUN rm -rf /app/aegis-app/node_modules/@aegis/sdk && \
    ln -sf /app/sdk /app/aegis-app/node_modules/@aegis/sdk

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
