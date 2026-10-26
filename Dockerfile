# Build stage
FROM node:22-alpine AS builder

# pnpm version comes from package.json "packageManager". node:22's bundled
# corepack predates pnpm 12's native-binary layout (looks for bin/pnpm.cjs),
# so upgrade corepack before enabling it.
RUN npm install -g corepack@0.36.0 && corepack enable

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Copy all source code
COPY . .

# Create dummy .env for Prisma (excluded by .dockerignore)
RUN touch .env

# Generate Prisma client (outputs to src/generated/prisma)
RUN pnpm prisma generate

# Create index.ts for module resolution (Prisma 7 doesn't generate this automatically)
RUN echo 'export * from "./client"' > src/generated/prisma/index.ts

# Verify generated files exist in src
RUN ls -la src/generated/prisma/

# Build the application
RUN pnpm run build

# Verify generated files are compiled to dist
RUN ls -la dist/generated/prisma/

# Prune dev dependencies
RUN pnpm prune --prod

# Production stage
FROM node:22-alpine AS production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

WORKDIR /app

# Copy built application (generated folder is compiled into dist/generated)
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/prisma.config.ts ./

# Copy and setup entrypoint script
COPY --chown=nestjs:nodejs scripts/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Set environment
ENV NODE_ENV=production

# Switch to non-root user
USER nestjs

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start the application (runs prisma db push then node)
CMD ["./docker-entrypoint.sh"]
