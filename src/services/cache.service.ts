import { Request } from 'express';
import { redisService } from './redis.service';
import { logger } from './logger.service';
import { authService } from './auth.service';
import { CachedResponse, CacheResult } from '../types';
import { config } from '../config/config';
import { LRUCache } from 'lru-cache';
import { promisify } from 'util';

/**
 * CacheService handles interactions with the Redis cache layer, implementing patterns
 * for high throughput (40k+ req/sec) including:
 * - In-memory hot cache for most accessed items
 * - Circuit breaker pattern to prevent Redis overload
 * - Back-pressure handling with controlled concurrency
 * - Graceful degradation during high load periods
 */
class CacheService {
  /**
   * In-memory LRU cache for ultra-fast responses to frequently accessed items
   * This serves as the first line of defense for high-traffic endpoints
   */
  private hotCache = new LRUCache<string, {data: CachedResponse, ttl: number}>({
    max: 5000,               // Keep 5000 hot items in memory
    ttl: 1000 * 60 * 0.5, // 30 seconds TTL for hot cache items
    updateAgeOnGet: true,    // Reset TTL on access
    ttlAutopurge: true,      // Auto clean expired items
    allowStale: false        // Don't return stale items
  });

  /**
   * Circuit breaker state to protect Redis from overload
   */
  private circuitState = {
    isOpen: false,           // Whether circuit is open (Redis protected)
    failureCount: 0,         // Count of consecutive Redis failures
    lastFailure: 0,          // Timestamp of last failure
    recoveryTimeout: 5000,   // 5 seconds recovery time before retry
    failureThreshold: 5,     // Number of failures before opening circuit
    requestQueue: [] as {    // Queue for controlled Redis access
      resolve: Function, 
      key: string
    }[],
    processing: false        // Flag if queue is being processed
  };

  /**
   * Utility for controlled delays during backpressure
   */
  private setTimeoutAsync = promisify(setTimeout);
  
  /**
   * Creates a standardized cache key for a request, including role information
   * Format: cache:METHOD:ROLE:PATH
   */
  createCacheKey(method: string, path: string, roleIdentifier: string): string {
    return `cache:${method}:${roleIdentifier}:${path}`;
  }
  
  /**
   * Gets normalized path including query string
   * Removes trailing slash for consistency
   */
  getNormalizedPath(request: Request): string {
    const path = request.originalUrl || '/';
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  }

  /**
   * Checks if cache should be bypassed based on headers
   */
  shouldBypassCache(request: Request): boolean {
    const cacheControl = request.headers['cache-control'] || '';
    const pragma = request.headers['pragma'] || '';
    return cacheControl.includes('no-cache') || pragma.includes('no-cache');
  }

  /**
   * Tries to get a response from cache with circuit breaker pattern
   * 
   * Implements:
   * 1. In-memory hot cache layer for ultra-fast responses
   * 2. Circuit breaker pattern to protect Redis under load
   * 3. Controlled concurrency for Redis access
   */
  async getFromCache(request: Request): Promise<CacheResult> {
    // Get commonly accessed headers early as constants for fast path evaluation
    const cacheControl = request.headers['cache-control'] || '';
    const pragma = request.headers['pragma'] || '';
    
    // Fast path for cache bypass - check headers first before doing any other work
    if (cacheControl.includes('no-cache') || pragma.includes('no-cache')) {
      return { hit: false, status: 'BYPASS' };
    }
    
    // Construct cache key components
    const method = request.method;
    const path = this.getNormalizedPath(request);
    const roleIdentifier = authService.getUserRoleIdentifier(request);
    const cacheKey = this.createCacheKey(method, path, roleIdentifier);

    // ===== TIER 1: Check hot cache first for ultra-fast responses =====
    const hotItem = this.hotCache.get(cacheKey);
    if (hotItem) {
      logger.debug(`Hot cache HIT for: ${cacheKey}`);
      return { 
        hit: true,
        status: 'HOT_HIT',
        data: hotItem.data,
        // Calculate remaining TTL in seconds 
        ttlRemaining: Math.floor((hotItem.ttl - Date.now()) / 1000)
      };
    }

    // ===== CIRCUIT BREAKER: Check if Redis is protected =====
    if (this.circuitState.isOpen) {
      // Circuit is open (Redis is overwhelmed)
      const timeSinceFailure = Date.now() - this.circuitState.lastFailure;
      
      if (timeSinceFailure < this.circuitState.recoveryTimeout) {
        // Still in recovery period, return cache miss directly
        logger.warn(`Circuit breaker open, skipping Redis for: ${cacheKey}`);
        return { hit: false, status: 'CIRCUIT_OPEN' };
      } else {
        // Recovery timeout passed, reset circuit state
        this.circuitState.isOpen = false;
        this.circuitState.failureCount = 0;
        logger.warn('Circuit breaker reset, resuming Redis operations');
      }
    }

    // ===== TIER 2: Try Redis with controlled access =====
    try {
      // Use controlled Redis access to avoid connection pool exhaustion
      const cachedEntryString = await this.controlledRedisGet(cacheKey);
      
      if (!cachedEntryString) {
        logger.info(`Cache MISS for: ${cacheKey}`);
        return { hit: false, status: 'MISS' };
      }
      
      try {
        const cachedEntry = JSON.parse(cachedEntryString) as CachedResponse;
        
        // Optimize Buffer reconstruction - only do it if needed
        if (cachedEntry.body && typeof cachedEntry.body === 'object' && 
            'type' in cachedEntry.body && cachedEntry.body.type === 'Buffer') {
          const bufferObj = cachedEntry.body as unknown as { type: string; data: number[] };
          cachedEntry.body = Buffer.from(bufferObj.data);
        }

        // Get TTL for the cached item (either from Redis or estimate)
        const ttlRemaining = await this.controlledGetTtl(cacheKey);
        
        // Store in hot cache for future requests
        if (ttlRemaining && ttlRemaining > 0) {
          this.hotCache.set(cacheKey, {
            data: cachedEntry,
            ttl: Date.now() + (ttlRemaining * 1000)
          });
        }
        
        logger.info(`Cache HIT for: ${cacheKey}`);
        return { 
          hit: true, 
          status: 'HIT', 
          data: cachedEntry,
          ttlRemaining
        };
      } catch (parseError) {
        logger.error(`Failed to parse cached entry for: ${cacheKey}`, parseError as Error);
        return { hit: false, status: 'ERROR' };
      }
    } catch (error) {
      // Track Redis failure for circuit breaker
      this.trackFailure();
      logger.error(`Redis error retrieving cache for: ${path}`, error as Error);
      return { hit: false, status: 'ERROR' };
    }
  }

  /**
   * Controlled Redis GET with back-pressure handling
   * Uses queueing during high load to protect Redis connection pool
   */
  private async controlledRedisGet(key: string): Promise<string | null> {
    // Use queue if we're under high load
    if (this.circuitState.requestQueue.length > 0) {
      return new Promise<string | null>((resolve) => {
        // Add this request to the queue
        this.circuitState.requestQueue.push({resolve, key});
        
        // Start processing the queue if not already doing so
        if (!this.circuitState.processing) {
          this.processQueue();
        }
      });
    }
    
    // Fast path - direct Redis access when no queue
    return await redisService.get(key);
  }

  /**
   * Controlled TTL retrieval with back-pressure handling
   * During high load, estimate TTL instead of making additional Redis calls
   */
  private async controlledGetTtl(key: string): Promise<number | undefined> {
    // If queue is growing, estimate TTL to avoid additional Redis calls
    if (this.circuitState.requestQueue.length > 10) {
      return 60; // Return a default 60 second TTL to avoid extra Redis calls under load
    }
    
    // Normal path - get actual TTL from Redis
    return await redisService.getTtl(key);
  }

  /**
   * Process the queue of pending Redis requests with controlled concurrency
   * This implements back-pressure handling to avoid overwhelming Redis
   */
  private async processQueue() {
    if (this.circuitState.processing) return;
    
    this.circuitState.processing = true;
    const batchSize = 10; // Process 10 requests at a time
    
    try {
      while (this.circuitState.requestQueue.length > 0) {
        // Take a batch of requests from the queue
        const batch = this.circuitState.requestQueue.splice(0, batchSize);
        
        // Process them concurrently with Promise.allSettled to handle errors gracefully
        const results = await Promise.allSettled(batch.map(async item => {
          const result = await redisService.get(item.key);
          return { key: item.key, result };
        }));
        
        // Resolve each promise with its result
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            batch[index].resolve(result.value.result);
          } else {
            batch[index].resolve(null); // Resolve with null in case of failure
            this.trackFailure();
          }
        });
        
        // If queue is still growing, add a small delay to avoid overwhelming Redis
        if (this.circuitState.requestQueue.length > 20) {
          await this.setTimeoutAsync(50); // 50ms delay between batches when under load
        }
      }
    } catch (error) {
      logger.error('Error processing Redis queue', error as Error);
    } finally {
      this.circuitState.processing = false;
    }
  }

  /**
   * Track failures for circuit breaker pattern
   * Opens the circuit when failure threshold is reached
   */
  private trackFailure() {
    this.circuitState.failureCount++;
    this.circuitState.lastFailure = Date.now();
    
    // Open the circuit if we've had too many failures
    if (this.circuitState.failureCount >= this.circuitState.failureThreshold) {
      if (!this.circuitState.isOpen) {
        logger.warn('Circuit breaker opened due to Redis failures. Reducing load on Redis.');
        this.circuitState.isOpen = true;
      }
    }
  }

  /**
   * Stores a response in cache with improved buffer handling
   * Updates both Redis and in-memory hot cache
   */
  async storeInCache(
    request: Request, 
    status: number, 
    headers: Record<string, string>, 
    body: Buffer
  ): Promise<void> {
    const method = request.method;
    // Only cache GET requests
    if (method !== 'GET') return;
    
    const path = this.getNormalizedPath(request);
    const roleIdentifier = authService.getUserRoleIdentifier(request);
    const cacheKey = this.createCacheKey(method, path, roleIdentifier);
    
    const cacheEntry: CachedResponse = {
      status: status,
      headers: headers,
      body: body // Store the buffer directly
    };

    // ==== TIER 1: Always update hot cache immediately ====
    this.hotCache.set(cacheKey, {
      data: cacheEntry,
      ttl: Date.now() + (config.cacheTtlSeconds * 1000)
    });

    // ==== CIRCUIT BREAKER: Skip Redis write if circuit is open ====
    if (this.circuitState.isOpen) {
      logger.debug(`Circuit breaker open, skipping Redis write for: ${cacheKey}`);
      return;
    }

    // ==== TIER 2: Store in Redis ====
    try {
      // Optimize JSON serialization to handle Buffer objects properly
      const cacheEntryString = JSON.stringify(cacheEntry, (key, value) => {
        // Special handling for Buffer objects when stringifying
        if (value && value.type === 'Buffer' && value.data) {
          // If it's already in {type:'Buffer',data:[...]} format, keep it as is
          return value;
        } else if (Buffer.isBuffer(value)) {
          // Convert Buffer to a format that can be reconstructed later
          return value.toJSON();
        }
        return value;
      });
      
      await redisService.set(cacheKey, cacheEntryString, config.cacheTtlSeconds);
      logger.info(`Stored response in cache for: ${cacheKey}`);
    } catch (error) {
      this.trackFailure();
      logger.error(`Failed to store response in cache: ${cacheKey}`, error as Error);
    }
  }

  /**
   * Invalidate cache by pattern
   * For role-based invalidation, we need to include the role pattern in the invalidation key
   */
  async invalidateCache(pattern: string): Promise<number> {
    // Clear any matching items from hot cache first
    this.invalidateHotCacheByPattern(pattern);
    
    // Then clear from Redis
    return await redisService.scanAndDeleteKeys(pattern);
  }

  /**
   * Invalidate hot cache entries matching a pattern
   * Uses simple string matching since we can't use Redis SCAN pattern matching
   */
  private invalidateHotCacheByPattern(pattern: string): void {
    // Convert Redis glob pattern to a RegExp
    // e.g., "cache:GET:*:something" becomes /^cache:GET:.*:something$/
    const regexPattern = new RegExp(
      '^' + pattern.replace(/\*/g, '.*') + '$'
    );
    
    // Get all keys in hot cache that match the pattern
    const keysToDelete: string[] = [];
    
    this.hotCache.forEach((_, key) => {
      if (regexPattern.test(key)) {
        keysToDelete.push(key);
      }
    });
    
    // Delete matched keys
    if (keysToDelete.length > 0) {
      logger.debug(`Invalidating ${keysToDelete.length} entries from hot cache`);
      keysToDelete.forEach(key => this.hotCache.delete(key));
    }
  }

  /**
   * Get a single cache entry by key
   * @param key - The cache key to retrieve
   * @returns The cached response or null if not found
   */
  async getByKey(key: string): Promise<CachedResponse | null> {
    // Check hot cache first
    const hotItem = this.hotCache.get(key);
    if (hotItem) {
      return hotItem.data;
    }
    
    try {
      const cachedEntryString = await redisService.get(key);
      if (cachedEntryString) {
        const cachedEntry = JSON.parse(cachedEntryString) as CachedResponse;
        
        // Properly reconstruct Buffer from its JSON representation
        if (cachedEntry.body && typeof cachedEntry.body === 'object' && 
            'type' in cachedEntry.body && cachedEntry.body.type === 'Buffer') {
          // Use type assertion to properly handle the Buffer JSON structure
          const bufferObj = cachedEntry.body as unknown as { type: string; data: number[] };
          cachedEntry.body = Buffer.from(bufferObj.data);
        }
        
        return cachedEntry;
      } else {
        return null;
      }
    } catch (error) {
      logger.error(`Redis error retrieving cache for key: ${key}`, error as Error);
      return null;
    }
  }

  /**
   * Get all cache keys
   * Returns keys from Redis (not hot cache)
   */
  async getAllKeys(): Promise<string[]> {
    return await redisService.getAllCacheKeys();
  }
  
  /**
   * Get hot cache stats for monitoring
   */
  getHotCacheStats(): Record<string, any> {
    return {
      size: this.hotCache.size,
      max: this.hotCache.max,
      circuitState: {
        isOpen: this.circuitState.isOpen,
        failureCount: this.circuitState.failureCount,
        queueLength: this.circuitState.requestQueue.length
      }
    };
  }
}

// Export singleton instance
export const cacheService = new CacheService();