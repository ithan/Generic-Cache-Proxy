# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY invalidation_config.json ./

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json ./
RUN npm install --production

# Copy build output and config files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/invalidation_config.json ./

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Create a non-root user to run the application
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Expose the port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "dist/server.js"]
