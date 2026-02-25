# Bitcoin Header Relayer
# Uses bun runtime for TypeScript execution

FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY . .

# Default command: start relay service
CMD ["bun", "run", "start"]
