import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { logger } from './logger.service';
import dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

class MetricsService {
  public register = register;
  public httpRequestsTotal: Counter;
  public httpRequestDurationSeconds: Histogram;
  public cacheKeysTotal: Gauge;
  public endpointUsageCounter: Counter;

  constructor() {
    // Set default labels with prefix from env
    const metrixPrefix = process.env.METRIX_PREFIX || '';
    if (metrixPrefix) {
      this.register.setDefaultLabels({
        app: metrixPrefix
      });
      logger.info(`Metrics prefix set to: ${metrixPrefix}`);
    }

    // Initialize Prometheus metrics
    collectDefaultMetrics({ 
      register: this.register,
      prefix: metrixPrefix ? `${metrixPrefix}_` : '' 
    });

    // Counter for HTTP requests
    this.httpRequestsTotal = new Counter({
      name: metrixPrefix ? `${metrixPrefix}_http_requests_total` : 'http_requests_total',
      help: 'Total number of HTTP requests processed',
      labelNames: ['method', 'path', 'status_code', 'cache_status'],
      registers: [this.register]
    });

    // Histogram for request duration
    this.httpRequestDurationSeconds = new Histogram({
      name: metrixPrefix ? `${metrixPrefix}_http_request_duration_seconds` : 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'path', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register]
    });

    // Gauge for cache size
    this.cacheKeysTotal = new Gauge({
      name: metrixPrefix ? `${metrixPrefix}_cache_keys_total` : 'cache_keys_total',
      help: 'Total number of keys currently in the cache',
      registers: [this.register]
    });

    // Counter for detailed endpoint usage tracking
    this.endpointUsageCounter = new Counter({
      name: metrixPrefix ? `${metrixPrefix}_endpoint_usage_total` : 'endpoint_usage_total',
      help: 'Detailed endpoint usage statistics by path, cache status, and user role',
      labelNames: ['method', 'path', 'cache_status', 'user_role'],
      registers: [this.register]
    });

    logger.info('Metrics service initialized');
  }

  /**
   * Records metrics for a completed request
   */
  recordRequestMetrics(
    method: string, 
    path: string, 
    statusCode: number, 
    cacheStatus: string, 
    durationSeconds: number,
    userRole: string = 'anonymous'
  ): void {
    // Record standard metrics
    this.httpRequestsTotal.labels(method, path, statusCode.toString(), cacheStatus).inc();
    this.httpRequestDurationSeconds.labels(method, path, statusCode.toString()).observe(durationSeconds);
    
    // Record detailed endpoint usage with user role information
    this.endpointUsageCounter.labels(method, path, cacheStatus, userRole).inc();
  }

  /**
   * Updates the cache keys count
   */
  updateCacheKeysCount(count: number): void {
    this.cacheKeysTotal.set(count);
  }

  /**
   * Gets the current Prometheus metrics
   */
  async getMetrics(): Promise<string> {
    return await this.register.metrics();
  }
}

// Export singleton instance
export const metricsService = new MetricsService();
