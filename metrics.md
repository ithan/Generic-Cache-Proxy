
## Prometheus / Thanos Queries

This service exports Prometheus metrics on the `/metrics` endpoint. The following PromQL queries can be used in Prometheus, Thanos, Grafana, or similar tools to monitor service performance and behavior.

**Notes:**

* All metric names below assume the `METRIX_PREFIX` environment variable is set to `caching_proxy_cache_development`. Adjust the prefix if you use a different value.
* Queries often use `rate(metric[5m])` to calculate the per-second average rate over a 5-minute window. Adjust the time window (`[5m]`) as needed for different granularities.
* The `path` label is normalized (e.g., `/api/v1/articles/123` becomes `/api/v1/articles/:id`). Use the normalized paths when filtering.
* The `endpoint_usage_total` metric includes a `user_role` label (`anonymous`, `authenticated`, `admin`, etc.).

---

### Request Rates & Throughput

**1. Overall Request Rate (Total RPS)**
* Description: Total number of requests per second across the entire service.
* Query:
    ```promql
    sum(rate(caching_proxy_cache_development_http_requests_total[5m]))
    ```

**2. Request Rate Per Endpoint Path**
* Description: Requests per second for each unique normalized endpoint path (sums all methods).
* Query:
    ```promql
    sum by (path) (rate(caching_proxy_cache_development_http_requests_total[5m]))
    ```

**3. Request Rate Per Endpoint (Method + Path)**
* Description: Requests per second broken down by both HTTP method and normalized path.
* Query:
    ```promql
    sum by (method, path) (rate(caching_proxy_cache_development_http_requests_total[5m]))
    ```

**4. Top 10 Most Frequently Hit Endpoints (Method + Path)**
* Description: Identifies the busiest endpoints based on average request rate.
* Query:
    ```promql
    topk(10, sum by (method, path) (rate(caching_proxy_cache_development_http_requests_total[5m])))
    ```

**5. Request Rate for a Specific Endpoint (e.g., `GET /health`)**
* Description: Monitors the rate for a single, specific endpoint.
* Query:
    ```promql
    # Example for GET /health
    sum(rate(caching_proxy_cache_development_http_requests_total{method="GET", path="/health"}[5m]))
    ```
    ```promql
    # Example for a normalized API path
    sum(rate(caching_proxy_cache_development_http_requests_total{method="GET", path="/api/v1/articles/:id"}[5m]))
    ```

### Cache Performance

**6. Overall Cache Hit Rate (Percentage)**
* Description: Percentage of cacheable (`GET`) requests served successfully from the cache (`HIT`) compared to all evaluated `GET` requests (`HIT`, `MISS`, `BYPASS`, `ERROR`, `REFRESH`).
* Query:
    ```promql
    (
      sum(rate(caching_proxy_cache_development_http_requests_total{method="GET", cache_status="HIT"}[5m]))
    /
      sum(rate(caching_proxy_cache_development_http_requests_total{method="GET", cache_status=~"HIT|MISS|BYPASS|ERROR|REFRESH"}[5m]))
    ) * 100
    ```

**7. Cache Status Rate Per Endpoint (Method + Path)**
* Description: Shows the rate of different cache statuses (HIT, MISS, BYPASS, etc.) for each endpoint.
* Query:
    ```promql
    sum by (method, path, cache_status) (rate(caching_proxy_cache_development_http_requests_total{method="GET"}[5m]))
    ```

**8. Current Number of Cache Keys**
* Description: The total number of keys currently stored in the cache (updated when `/keys` endpoint is scraped or manually triggered).
* Query:
    ```promql
    caching_proxy_cache_development_cache_keys_total
    ```

### Request Duration & Latency

**9. Average Request Duration Per Endpoint (Method + Path)**
* Description: Calculates the average request duration in seconds for each endpoint over the last 5 minutes.
* Query:
    ```promql
    sum by (method, path) (rate(caching_proxy_cache_development_http_request_duration_seconds_sum[5m]))
    /
    sum by (method, path) (rate(caching_proxy_cache_development_http_request_duration_seconds_count[5m]))
    ```

**10. 95th Percentile Request Duration Per Endpoint (Method + Path)**
* Description: Shows the 95th percentile request duration in seconds for each endpoint (requires the histogram data).
* Query:
    ```promql
    histogram_quantile(0.95, sum by (le, method, path) (rate(caching_proxy_cache_development_http_request_duration_seconds_bucket[5m])))
    ```
    *(You can change `0.95` to other quantiles like `0.50` (median) or `0.99`)*

### Error Rates

**11. Overall 5xx Error Rate**
* Description: Total rate of server-side errors (HTTP status 500-599) per second.
* Query:
    ```promql
    sum(rate(caching_proxy_cache_development_http_requests_total{status_code=~"5.."}[5m]))
    ```

**12. 5xx Error Rate Per Endpoint Path**
* Description: Rate of server-side errors per second for each unique normalized endpoint path.
* Query:
    ```promql
    sum by (path) (rate(caching_proxy_cache_development_http_requests_total{status_code=~"5.."}[5m]))
    ```

### User Role Analysis (Using `endpoint_usage_total`)

**13. Overall Request Rate Per User Role**
* Description: Shows the total requests per second broken down by user role (`anonymous`, `authenticated`, `admin`, etc.).
* Query:
    ```promql
    sum by (user_role) (rate(caching_proxy_cache_development_endpoint_usage_total[5m]))
    ```

**14. Request Rate Per Endpoint Per User Role**
* Description: Breaks down request rates for each endpoint by the user role making the request.
* Query:
    ```promql
    sum by (method, path, user_role) (rate(caching_proxy_cache_development_endpoint_usage_total[5m]))
    ```

**15. Cache Status Rate by User Role for a Specific Endpoint**
* Description: Shows how different user roles experience cache hits/misses for a specific endpoint.
* Query:
    ```promql
    # Example for GET /api/v1/articles/:id
    sum by (cache_status, user_role) (rate(caching_proxy_cache_development_endpoint_usage_total{method="GET", path="/api/v1/articles/:id"}[5m]))
    ```
