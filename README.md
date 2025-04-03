# High-Performance Caching Proxy

## Overview

This project implements a high-performance caching proxy built with Node.js, TypeScript, and Express. It acts as an intermediary layer between clients (e.g., frontend applications) and a backend service, primarily designed to accelerate response times for frequently accessed resources and reduce load on the backend.

It leverages multi-layer caching (in-memory hot cache + Redis/KeyDB), robust connection pooling, circuit breaking, and other optimization techniques to handle high throughput efficiently.

## Key Features

* **Request Proxying:** Forwards incoming client requests to a configurable backend service.
* **Multi-Layer Caching:**
    * **Redis/KeyDB Caching:** Caches successful `GET` responses in a Redis or KeyDB instance with a configurable Time-To-Live (TTL).
    * **In-Memory Hot Cache (LRU):** Keeps the most frequently accessed items in a local LRU cache for ultra-fast responses, reducing Redis/KeyDB load.
    * **In-Memory Data/TTL Burst Cache (Redis Service):** Temporarily caches data and TTLs fetched from Redis in memory to absorb short bursts of requests for the same key, further reducing direct Redis operations.
* **Role-Based Caching:** Generates unique cache keys based on user roles (extracted from JWTs), ensuring users only see data appropriate for their permissions.
* **Performance Optimizations:**
    * **Circuit Breaker:** Protects Redis/KeyDB from overload during periods of high failure rates.
    * **Adaptive Connection Pooling:** Manages a pool of Redis connections with adaptive sizing, health checks, and efficient reuse.
    * **Controlled Concurrency:** Queues Redis operations under heavy load to prevent overwhelming the cache server or exhausting the connection pool.
    * **Optimized HTTP Client:** Uses `axios` with persistent keep-alive agents for efficient backend communication.
    * **Efficient Data Handling:** Uses Buffers for request/response bodies, optimized header processing, and conditional raw body parsing.
    * **Non-Blocking Operations:** Cache writes and background invalidations occur asynchronously without blocking the response path.
* **Cache Invalidation:**
    * **Time-Based (TTL):** Automatic expiration based on configured TTL.
    * **Automatic (POST-based):** Configurable rules to automatically invalidate related `GET` caches after successful `POST` requests.
    * **Manual:** API endpoint (`/invalidate`) to clear cache entries by pattern.
* **Monitoring & Observability:**
    * **Prometheus Metrics:** Exposes detailed metrics (`/metrics`) including request counts, durations, cache statistics (hits/misses), connection pool status, and Node.js runtime metrics. Supports custom metric prefixes via `METRIX_PREFIX`.
    * **Health Check:** Simple `/health` endpoint for liveness probes.
    * **Structured Logging:** Uses Pino for efficient JSON logging.
* **Administration:** Endpoints to list cache keys (`/keys`) and inspect specific cache entries (`/key`) for debugging.
* **Dockerized:** Includes Dockerfile and Docker Compose setup for easy deployment with KeyDB/Redis.
* **Graceful Shutdown:** Handles termination signals to close connections cleanly.

## Technology Stack

* **Framework:** Express.js
* **Language:** TypeScript
* **Caching:**
    * Redis / KeyDB (via `ioredis`)
    * In-Memory LRU Cache (`lru-cache`)
* **HTTP Client:** Axios
* **Logging:** Pino, Pino-HTTP, Pino-Pretty (dev)
* **Metrics:** Prom-client
* **Configuration:** Dotenv
* **Containerization:** Docker, Docker Compose
* **Runtime:** Node.js

## Core Concepts / How it Works

1.  **Request Received:** A client sends an API request to this caching proxy service.
2.  **Middleware:** Request logging, body parsing (JSON or Raw based on Content-Type and method), and metrics timing start.
3.  **Routing:** The request hits either an admin route (`/health`, `/metrics`, etc.) or the catch-all proxy route.
4.  **Proxy Route (`proxy.controller.ts`):**
    * **Method Check:** Determines the HTTP method.
    * **`GET` Request:**
        * **Auth Check:** Extracts user role identifier (`anonymous`, `authenticated`, `admin`, etc.) from `Authorization: Bearer <token>` using `auth.service.ts` (caches decoded tokens briefly).
        * **Cache Key:** Generates a role-specific key (e.g., `cache:GET:<role>:<path>?<query>`).
        * **Cache Lookup (`cache.service.ts`):**
            * Checks client `Cache-Control`/`Pragma` headers for bypass instructions (`BYPASS`).
            * Checks **Hot Cache (LRU)**. If hit (`HOT_HIT`), returns cached `Buffer` response immediately.
            * Checks **Circuit Breaker**. If open (`CIRCUIT_OPEN`), bypasses Redis/KeyDB.
            * Checks **Redis/KeyDB** (using pooled connections via `redis.service.ts`, which includes its own memory burst cache).
                * If hit (`HIT`), stores the result in the Hot Cache and returns the cached `Buffer` response.
                * If miss (`MISS` or error), proceeds to proxy.
        * **Proxy Request (`proxy.service.ts`):** Forwards the request to the `BACKEND_URL` using the optimized Axios client.
    * **Other Methods (POST, PUT, DELETE, etc.):** Request is directly proxied to the `BACKEND_URL`.
5.  **Backend Response Handling (`proxy.service.ts`):**
    * Receives the response (status, headers, body as Buffer) from the backend.
    * Sends the response back to the original client.
    * **Caching (`GET` only):** If the request was a `GET`, the backend response was successful (e.g., 2xx), and it wasn't a cache `HIT` or `BYPASS`, the response (status, specific headers, body Buffer) is stored **asynchronously** in both Redis/KeyDB (via `redis.service.ts`) and the Hot Cache (via `cache.service.ts`) with the configured TTL.
    * Adds appropriate `X-Cache-Status` and cache expiration headers.
6.  **POST Invalidation (`proxy.controller.ts` & `invalidation.service.ts`):**
    * *After* a successful `POST` request is proxied and the response sent to the client, the `invalidation.service` checks `invalidation_config.json`.
    * If the POST path matches a rule's `post_path_regex`, the corresponding `invalidate_patterns` are resolved (substituting regex capture groups and adding role wildcards).
    * The service triggers an **asynchronous** invalidation of matching keys in both Redis/KeyDB and the Hot Cache.
7.  **Metrics Recording (`metrics.middleware.ts`):** After the response is finished, metrics (request count, duration, path, status, cache status, user role) are recorded.

## Project Structure

```
├── dist/                    # Compiled JavaScript output (from TypeScript)
├── docker/                  # Docker configurations
│   ├── cache-service/  # Example Docker context for the service (rename if needed)
│   │   ├── Dockerfile       # Multi-stage Dockerfile
│   │   └── cache-service.yaml # Example Docker Compose service definition
│   └── keydb/               # Example Docker context for KeyDB/Redis
│       └── keydb.yml        # Example Docker Compose service definition
├── src/                     # TypeScript source code
│   ├── config/              # Configuration loading (env vars)
│   ├── controllers/         # Express route handlers
│   ├── middleware/          # Express middleware functions
│   ├── routes/              # Express route definitions
│   ├── services/            # Core logic (caching, proxying, auth, Redis, etc.)
│   └── types/               # TypeScript type definitions and interfaces
│   ├── app.ts               # Express application setup
│   └── server.ts            # Server initialization, startup, graceful shutdown
├── .env.example             # Example environment variables (CREATE THIS)
├── docker-compose.yml       # Main Docker Compose file (includes other yaml files)
├── invalidation_config.json # Rules for automatic POST-based cache invalidation
├── metrics.md               # (Optional) Documentation specific to metrics
├── openapi.json             # (Optional) OpenAPI specification if used
├── package.json             # Project dependencies and scripts
├── README.md                # This file
├── stress.js                # Example k6 stress test script
└── tsconfig.json            # TypeScript compiler options
```

## Getting Started

### Prerequisites

* Node.js (v20.x or later recommended)
* npm (usually included with Node.js)
* Docker & Docker Compose
* A running instance of the Backend Service this proxy will connect to.
* A running instance of Redis or KeyDB (or use the provided Docker Compose setup).

### Configuration (`.env` file)

Create a `.env` file in the project root (you can copy `.env.example` if provided).

```dotenv
# .env Example

# --- Required ---
# Base URL of the backend service to proxy requests to
BACKEND_URL=[http://your-backend-service.example.com](https://www.google.com/search?q=http://your-backend-service.example.com)
# Connection URL for Redis or KeyDB cache instance
CACHE_URL=redis://keydb:6379 # Default if using provided docker-compose

# --- Optional ---
# Port the proxy service will listen on
PORT=3000
# Logging level (trace, debug, info, warn, error, fatal)
LOG_LEVEL=info
# Default cache expiration time in seconds
CACHE_TTL_SECONDS=1800 # 30 minutes
# Node environment (development, production) - influences logging, error details
NODE_ENV=production
# Optional prefix for Prometheus metrics (e.g., myapp)
METRIX_PREFIX=caching_proxy
# Port exposed by the KeyDB/Redis container (used in docker-compose.yml)
KEYDB_PORT=6379
```

### Running with Docker Compose (Recommended)

This starts the caching proxy service and a KeyDB instance.

1.  Ensure your `.env` file is created and configured, especially `BACKEND_URL`.
2.  Build and start the services:
    ```bash
    docker-compose up --build -d
    ```
    * `--build`: Rebuilds the image if code changes.
    * `-d`: Runs in detached mode.
3.  The service will be accessible on the `PORT` specified in `.env` (e.g., `http://localhost:3000`). KeyDB will be accessible internally at `redis://keydb:6379` (or based on `CACHE_URL` if overridden).

### Stopping Docker Compose

```bash
docker-compose down
```

### Running Locally (for Development)

1.  Ensure your `.env` file is configured. `CACHE_URL` should point to an accessible Redis/KeyDB instance (e.g., running via `docker-compose up -d keydb` or a separate instance). Set `NODE_ENV=development`.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the development server:
    ```bash
    npm run dev
    ```
    This uses `ts-node` and `nodemon` for live reloading and `pino-pretty` for readable logs.

## Configuration Details

* **Environment Variables:** Defined in `src/config/config.ts` and loaded from `.env`. See the `.env Example` section above.
* **`invalidation_config.json`:** Defines rules for automatic cache invalidation after `POST` requests. See the "Cache Invalidation" section for details.

## API Endpoints

### Proxy Endpoint

* **`*` (All methods, all paths not matching admin endpoints)**
    * **Description:** The main endpoint that proxies requests to the configured `BACKEND_URL`. Handles caching for `GET` requests and automatic invalidation based on `POST` requests.
    * **Behavior:** See "Core Concepts / How it Works".
    * **Cache Headers:** Adds `X-Cache-Status`, `X-Cache-Expires-In`, `X-Cache-Expires-At` to responses where applicable.

### Admin Endpoints

* **`GET /health`**
    * **Description:** Basic liveness check.
    * **Response:** `200 OK` with JSON body: `{ "status": "ok", "timestamp": "..." }`

* **`GET /metrics`**
    * **Description:** Exposes metrics in Prometheus text format.
    * **Response:** Prometheus metrics exposition including `http_requests_total`, `http_request_duration_seconds`, `cache_keys_total`, `endpoint_usage_total`, connection pool stats, memory cache stats, and default Node.js metrics.

* **`POST /invalidate`**
    * **Description:** Manually invalidates cache entries (Redis/KeyDB and Hot Cache) matching a pattern.
    * **Request Body:** `application/json`
        ```json
        {
          "pattern": "cache:GET:*:..."
        }
        ```
    * `pattern`: A Redis key pattern (e.g., `cache:GET:*:*/api/users/*`, `cache:GET:admin:/api/config`). Use `*` as a wildcard.
    * **Response:** `200 OK` with JSON body indicating completion and count: `{ "message": "...", "deletedCount": N }`

* **`GET /keys`**
    * **Description:** Lists all cache keys currently in Redis/KeyDB, grouped by role. **Warning:** Uses `SCAN`, potentially resource-intensive on Redis if there are many keys. Use cautiously in production.
    * **Response:** `200 OK` with JSON body:
        ```json
        {
          "keyCount": N,
          "keysByRole": {
            "anonymous": ["key1", "key2"],
            "authenticated": ["key3"],
            "admin": [],
            // ... other roles or "legacy"
          },
          "keys": [ /* Flat list of all keys */ ]
        }
        ```

* **`POST /key`**
    * **Description:** Retrieves a specific cache entry (including headers and body) by its full key. Intended for debugging.
    * **Request Body:** `application/json`
        ```json
        {
          "key": "cache:GET:anonymous:/api/some/path"
        }
        ```
    * **Response:** `200 OK` with the cached data `{ "message": "...", "cacheEntry": { "status": ..., "headers": ..., "body": ... } }` or `404 Not Found`.

## Caching & Invalidation

### Cache Layers

1.  **Hot Cache (In-Memory LRU):** Fastest layer (`cache.service.ts`). Holds a limited number of frequently accessed items. TTL typically shorter than Redis TTL.
2.  **Redis/KeyDB:** Persistent cache layer (`redis.service.ts`). Stores all cacheable items with the full TTL.
3.  **Redis Service Burst Cache (In-Memory LRU):** Short-lived cache within `redis.service.ts` to deduplicate rapid requests for the *same key* to Redis itself (both data and TTL lookups).

### Cache Key Format

Keys typically follow the pattern: `cache:<METHOD>:<ROLE_IDENTIFIER>:<NORMALIZED_PATH_WITH_QUERY>`
* `METHOD`: Usually `GET`.
* `ROLE_IDENTIFIER`: `anonymous`, `authenticated`, `admin`, or a hyphen-separated sorted list of roles from JWT.
* `NORMALIZED_PATH_WITH_QUERY`: The request path and query string, normalized (e.g., trailing slash removed).

### Invalidation Mechanisms

1.  **Time-To-Live (TTL):** Cache entries automatically expire after `CACHE_TTL_SECONDS`. Both Hot Cache and Redis/KeyDB respect TTLs (though Hot Cache might have a shorter one).
2.  **Automatic POST Invalidation:**
    * Configured in `invalidation_config.json`.
    * When a `POST` request successfully completes, the service checks if the request path matches any `post_path_regex`.
    * If matched, the corresponding `invalidate_patterns` are used to clear entries.
    * **Pattern Resolution:** `$1`, `$2`, etc., in patterns are replaced with captured groups from the regex match.
    * **Role Wildcarding:** The service *automatically modifies* patterns like `cache:GET:/some/path/$1` to `cache:GET:*:/some/path/$1` before invalidation. This ensures all role variants are cleared unless a specific role (e.g., `:admin:`) is already part of the pattern.
    * **Example Rule:**
        ```json
        // invalidation_config.json
        [
          {
            // When POST /api/products/{id} is called...
            "post_path_regex": "^/api/products/(\\d+)$", // Captures ID as $1
            "invalidate_patterns": [
              // ...invalidate the specific product cache (for ALL roles)
              "cache:GET:/api/products/$1",
              // ...and also invalidate the general product list cache (for ALL roles)
              "cache:GET:/api/products"
            ]
          }
        ]
        ```
3.  **Manual Invalidation:**
    * Use the `POST /invalidate` admin endpoint.
    * Provide a specific pattern (e.g., `cache:GET:admin:/api/admin/users*` to clear admin user caches, or `cache:GET:*:/api/products/123` to clear a specific product for all roles).

### Cache Refresh Headers

Clients can force a cache refresh (fetch from backend but still update the cache) by sending headers like:
* `Cache-Control: no-cache`
* `Cache-Control: max-age=0`
* `Pragma: no-cache`
* `Cache-Refresh: true` (Custom)
* `X-Cache-Refresh: true` (Custom)

The service will respond with `X-Cache-Status: REFRESH`.

## Performance Features Summary

* **Multi-Layer Caching:** Reduces latency and backend load (Hot Cache, Redis Burst Cache).
* **Circuit Breaker:** Prevents cascading failures by isolating Redis/KeyDB during issues.
* **Adaptive Connection Pooling:** Optimizes Redis resource usage and resilience.
* **Controlled Concurrency:** Manages Redis load gracefully under pressure.
* **Keep-Alive Connections:** Reduces overhead for backend communication (`axios` agents).
* **Asynchronous Operations:** Cache writes and invalidations don't block responses.
* **Efficient Data Structures:** Buffers for bodies, LRU caches, optimized lookups.

## Monitoring

* **Health:** Use `GET /health` for liveness checks (e.g., in Kubernetes, Docker Swarm). The provided Dockerfile includes a `HEALTHCHECK`.
* **Metrics:** Scrape `GET /metrics` with Prometheus. Monitor key metrics like:
    * `http_requests_total` (by path, status, cache\_status)
    * `http_request_duration_seconds` (histogram)
    * `endpoint_usage_total` (by path, cache\_status, user\_role)
    * `cache_keys_total` (gauge, updated via `/keys` endpoint)
    * `*_cache_*` metrics from `redis.service.ts` (memory cache hits/misses, saved ops)
    * `*_pool_*` metrics from `redis.service.ts` (pool size, usage, acquisition time)
    * Default Node.js metrics (`process_*`, `nodejs_*`)
* **Logging:** Logs are structured JSON (Pino). Configure Docker logging drivers (`json-file`, `fluentd`, etc.) or stream logs from `stdout`/`stderr` in your deployment environment. `json-file` rotation is configured in the example `docker-compose` files.

## Development

### Building for Production

```bash
npm run build
```
This compiles TypeScript from `src/` to JavaScript in `dist/`.

### Running Compiled Code

```bash
npm start
# OR
node dist/server.js
```
Ensure dependencies are installed (`npm install --production`) and the `.env` file is configured.

### Performance Analysis & Stress Testing

* **Profiling:** Use `0x`, `clinic.js` (scripts provided in `package.json`: `clinic-doctor`, `clinic-flame`, etc.), or Node's built-in profiler.
    ```bash
    # Example using clinic flame
    npm run profile
    ```
* **Stress Testing:** Use tools like `k6`. An example script (`stress.js`) is included.
    ```bash
    # Ensure k6 is installed
    npm run stress-test
    # OR
    k6 run stress.js
    ```

## Deployment

* The primary method is using Docker and Docker Compose.
* Ensure the `.env` file is correctly configured in the deployment environment.
* Configure your load balancer or reverse proxy (e.g., Nginx, Traefik) to route traffic to the deployed container's exposed `PORT`.
* Set up monitoring (Prometheus scraping `/metrics`, log collection).
* The provided `Dockerfile` creates an optimized, multi-stage production image running as a non-root user.
