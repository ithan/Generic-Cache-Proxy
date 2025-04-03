import Redis, { Redis as RedisType } from 'ioredis';
import { config } from '../config/config';
import { logger } from './logger.service';
import { LRUCache } from 'lru-cache';


interface PoolItem {
  connection: RedisType;
  inUse: boolean;
  created: number;
  lastUsed: number;
  lastReturn: number;
  id: string;
}

class RedisService {
  private client!: RedisType;
  private connectionPool: PoolItem[] = [];
  private readonly maxPoolSize : number = 10; // Increased from 5
  private readonly minPoolSize : number = 2;
  private isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectInterval = 10000; // 10 seconds between reconnection attempts
  
  private readonly connectionMetrics = {
    requestCount: 0,
    hitCount: 0,
    missCount: 0,
    errorCount: 0,
    avgAcquisitionTime: 0,
    lastResize: Date.now(),
    lastHealth: Date.now()
  };

  private ttl_cache = new LRUCache<string, number>({
    max: 10000,               // Maximum number of items to store
    ttl: 5000,                // 5 second TTL
    updateAgeOnGet: true,     // Reset TTL when accessed
    allowStale: false         // Don't return stale items
  });

  // In-memory data cache for burst protection
  private data_cache = new LRUCache<string, string>({
    max: 5000,                // Store up to 5000 items
    ttl: 10000,               // 10 second TTL by default
    updateAgeOnGet: true,     // Reset TTL on access
    allowStale: false         // Don't return stale data
  });

  // Cache statistics for monitoring
  private cache_metrics = {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    savedRedisOps: 0,
    lastReset: Date.now()
  };


  constructor(poolSize?: number) {
    if (poolSize && poolSize > 0) {
      this.minPoolSize = poolSize;
    }
    this.initializeClient();
  }

  private initializeClient(): void {
    try {
      // Initialize the main client for status tracking
      this.client = this.createRedisClient();
      
      // Set up the connection pool
      this.initializeConnectionPool();
      
      this.setupListeners();
    } catch (error) {
      logger.error('Failed to initialize Redis client', error as Error);
      this.isConnected = false;
      this.scheduleReconnect();
    }
  }
  
  private createRedisClient(): RedisType {
    return new Redis(config.cacheUrl, {
      maxRetriesPerRequest: 3,
      showFriendlyErrorStack: process.env.NODE_ENV === 'development',
      // Set reasonable timeouts
      connectTimeout: 5000,     // 5 seconds to connect
      commandTimeout: 3000,     // 3 seconds for commands to complete
      retryStrategy: (times) => {
        // Return milliseconds to wait before retrying
        // We'll limit automatic retries and handle reconnection ourselves
        // For the first 3 attempts, use exponential backoff
        // 1s, 2s, 4s, ... capped at 3 seconds
        return Math.min(times * 1000, 3000);
      },
    });
  }
  
  private initializeConnectionPool(): void {
    logger.info(`Initializing Redis connection pool with ${this.minPoolSize} connections`);
    this.connectionPool = [];
    
    // Create pool connections
    for (let i = 0; i < this.minPoolSize; i++) {
      const connection = this.createRedisClient();
      this.setupConnectionListeners(connection, i);

      this.connectionPool.push({
        connection,
        inUse: false,
        created: Date.now(),
        lastUsed: 0,
        lastReturn: 0,
        id: `conn-${i + 1}`
      });
    }
  }

  /**
   * Set up listeners for a single connection
   */
  private setupConnectionListeners(connection: RedisType, index: number): void {
    connection.on('error', (err) => {
      logger.error(`Redis pool connection #${index} error`, err);
      // Mark connection as unavailable
      const poolItem = this.connectionPool.find(item => item.connection === connection);
      if (poolItem) {
        poolItem.inUse = true; // Mark as in use to avoid returning to the pool
      }
    });
    
    connection.on('end', () => {
      // Mark connection as unavailable
      const poolItem = this.connectionPool.find(item => item.connection === connection);
      if (poolItem) {
        poolItem.inUse = true; // Mark as in use to avoid returning to the pool
      }
    });
  }

  private setupListeners(): void {
    this.client.on('error', (err) => {
      logger.error('Redis client error', err);
      this.isConnected = false;
    });
    
    this.client.on('connect', () => {
      logger.info('Connected to Redis');
    });
    
    this.client.on('ready', () => {
      logger.info('Redis client ready');
      this.isConnected = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      
      // Reinitialize the connection pool if needed
      if (this.connectionPool.every(item => item.inUse)) {
        this.initializeConnectionPool();
      }
    });
    
    this.client.on('end', () => {
      logger.warn('Redis connection closed');
      this.isConnected = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.reconnectTimer) {
      logger.info(`Scheduling Redis reconnection attempt in ${this.reconnectInterval/1000}s`);
      this.reconnectTimer = setTimeout(() => {
        logger.info('Attempting to reconnect to Redis');
        this.reconnectTimer = null;
        this.initializeClient();
      }, this.reconnectInterval);
    }
  }

  /**
   * Check if Redis is currently available
   */
  isAvailable(): boolean {
    return this.isConnected && this.client.status === 'ready';
  }

  /**
   * Ping Redis to check health
   */
  async ping(): Promise<boolean> {
    if (!this.isConnected) return false;
    
    try {
      const response = await this.client.ping();
      return response === 'PONG';
    } catch (error) {
      logger.error('Redis ping failed', error as Error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Gets a connection from the pool with adaptive sizing and health checks
   * Returns a tuple with the connection and a function to return it to the pool
   */
  private getConnectionFromPool(): [RedisType, () => void] {
    const startTime = process.hrtime.bigint();
    this.connectionMetrics.requestCount++;
    
    // Fast failure if Redis is not available at all
    if (!this.isAvailable()) {
      this.connectionMetrics.errorCount++;
      return [this.client, () => { /* no-op */ }];
    }
    
    // Health check and pool management (do this infrequently)
    const now = Date.now();
    if (now - this.connectionMetrics.lastHealth > 30000) { // 30 seconds
      this.performHealthCheck();
      this.connectionMetrics.lastHealth = now;
    }
    
    // Adaptive pool sizing (also infrequent)
    if (now - this.connectionMetrics.lastResize > 60000) { // 1 minute
      this.adjustPoolSize();
      this.connectionMetrics.lastResize = now;
    }

    // Get the least recently used available connection
    const availableConnections = this.connectionPool
      .filter(item => !item.inUse && item.connection.status === 'ready')
      .sort((a, b) => a.lastUsed - b.lastUsed);
    
    if (availableConnections.length > 0) {
      const poolItem = availableConnections[0];
      poolItem.inUse = true;
      poolItem.lastUsed = now;
      
      // Track metrics
      this.connectionMetrics.hitCount++;
      const duration = process.hrtime.bigint() - startTime;
      this.connectionMetrics.avgAcquisitionTime = 
        (this.connectionMetrics.avgAcquisitionTime * 0.95) + 
        (Number(duration) / 1000000) * 0.05; // Exponential moving average
      
      // Return with connection release function
      const returnToPool = () => {
        if (poolItem.connection.status === 'ready') {
          poolItem.inUse = false;
          poolItem.lastReturn = Date.now();
        } else {
          // Replace broken connections
          this.replaceConnection(poolItem);
        }
      };
      
      return [poolItem.connection, returnToPool];
    }
    
    // No connection available - consider creating one if below max
    if (this.connectionPool.length < this.maxPoolSize) {
      try {
        const newConnection = this.createRedisClient();
        const newItem: PoolItem = {
          connection: newConnection,
          inUse: true,
          created: now,
          lastUsed: now,
          lastReturn: 0,
          id: `conn-${this.connectionPool.length + 1}`
        };
        
        this.setupConnectionListeners(newConnection, this.connectionPool.length);
        this.connectionPool.push(newItem);
        
        logger.info(`Dynamically expanded Redis pool to ${this.connectionPool.length} connections`);
        
        const returnToPool = () => {
          if (newItem.connection.status === 'ready') {
            newItem.inUse = false;
            newItem.lastReturn = Date.now();
          } else {
            this.replaceConnection(newItem);
          }
        };
        
        return [newConnection, returnToPool];
      } catch (error) {
        logger.error('Failed to create additional Redis connection', error as Error);
      }
    }
    
    // If we got here, pool is full and all connections are busy
    this.connectionMetrics.missCount++;
    logger.info('All Redis connections busy, using fallback client');
    
    // Return main client as fallback
    return [this.client, () => { /* no-op */ }];
  }

  /**
   * Adjusts pool size based on usage patterns
   */
  private adjustPoolSize(): void {
    const totalRequests = this.connectionMetrics.hitCount + this.connectionMetrics.missCount;
    if (totalRequests < 100) return; // Not enough data
    
    const missRate = this.connectionMetrics.missCount / totalRequests;
    const currentSize = this.connectionPool.length;
    
    // Scale up if miss rate is high and below max size
    if (missRate > 0.1 && currentSize < this.maxPoolSize) {
      const newSize = Math.min(this.maxPoolSize, Math.ceil(currentSize * 1.5));
      this.expandPoolTo(newSize);
      logger.info(`Redis pool resized: ${currentSize} → ${newSize} connections (miss rate: ${(missRate * 100).toFixed(1)}%)`);
    } 
    // Scale down if miss rate is low and pool is larger than minimum
    else if (missRate < 0.01 && currentSize > this.minPoolSize) {
      const newSize = Math.max(this.minPoolSize, Math.floor(currentSize * 0.8));
      this.shrinkPoolTo(newSize);
      logger.info(`Redis pool resized: ${currentSize} → ${newSize} connections (miss rate: ${(missRate * 100).toFixed(1)}%)`);
    }
    
    // Reset metrics after adjustment
    this.connectionMetrics.hitCount = 0;
    this.connectionMetrics.missCount = 0;
  }

  /**
   * Expands the connection pool to the specified size
   */
  private expandPoolTo(newSize: number): void {
    const currentSize = this.connectionPool.length;
    const toAdd = newSize - currentSize;
    
    if (toAdd <= 0) return;
    
    for (let i = 0; i < toAdd; i++) {
      try {
        const connection = this.createRedisClient();
        const poolIndex = currentSize + i;
        this.setupConnectionListeners(connection, poolIndex);
        
        this.connectionPool.push({
          connection,
          inUse: false,
          created: Date.now(),
          lastUsed: 0,
          lastReturn: 0,
          id: `conn-${poolIndex + 1}`
        });
      } catch (error) {
        logger.error('Error creating new Redis connection during pool expansion', error as Error);
        break;
      }
    }
  }

  /**
   * Shrinks the connection pool to the specified size
   */
  private shrinkPoolTo(newSize: number): void {
    if (newSize >= this.connectionPool.length) return;
    
    // Sort by least recently used
    this.connectionPool.sort((a, b) => a.lastUsed - b.lastUsed);
    
    // Remove excess connections (oldest first, never in-use ones)
    while (this.connectionPool.length > newSize) {
      const item = this.connectionPool[0];
      if (item.inUse) {
        break; // Don't remove in-use connections
      }
      
      // Remove and close
      this.connectionPool.shift();
      try {
        item.connection.quit().catch(err => 
          logger.error(`Error closing Redis connection during pool reduction: ${item.id}`, err)
        );
      } catch (error) {
        logger.error(`Error during connection shutdown: ${item.id}`, error as Error);
      }
    }
  }

  /**
   * Performs health check on all pool connections
   */
  private performHealthCheck(): void {
    const unhealthyConnections: PoolItem[] = [];
    
    for (const item of this.connectionPool) {
      if (item.inUse) continue; // Skip in-use connections
      
      // Check status directly first to avoid async operation when possible
      if (item.connection.status !== 'ready') {
        unhealthyConnections.push(item);
        continue;
      }
      
      // Schedule ping check for connections not currently in use
      item.connection.ping()
      .catch(() => {
        // Connection failed ping test
        this.replaceConnection(item);
      });
    }
    
    // Replace immediately detected unhealthy connections
    for (const item of unhealthyConnections) {
      this.replaceConnection(item);
    }
    
    if (unhealthyConnections.length > 0) {
      logger.info(`Redis health check: replaced ${unhealthyConnections.length} unhealthy connections`);
    }
  }

  /**
   * Replaces a broken connection with a new one
   */
  private replaceConnection(item: PoolItem): void {
    try {
      // Close the old connection
      item.connection.quit().catch(() => {
        // Ignore errors during shutdown of already broken connections
      });
      
      // Create a new connection
      const newConnection = this.createRedisClient();
      const index = this.connectionPool.findIndex(i => i === item);
      if (index >= 0) {
        this.setupConnectionListeners(newConnection, index);
      }
      
      // Replace in the pool
      item.connection = newConnection;
      item.inUse = false;
      item.lastUsed = 0;
      item.lastReturn = 0; // Reset last return time
    } catch (error) {
      logger.error(`Failed to replace broken Redis connection ${item.id}`, error as Error);
      
      // Mark as in-use to prevent it from being selected
      item.inUse = true;
    }
  }

  /**
   * Gets the Redis client instance
   */
  getClient(): RedisType {
    return this.client;
  }

  /**
   * Get a cached value by key with in-memory burst protection
   */
  async get(key: string): Promise<string | null> {
    this.cache_metrics.totalRequests++;
    
    // First check the in-memory cache
    const cachedValue = this.data_cache.get(key);
    if (cachedValue !== undefined) {
      this.cache_metrics.hits++;
      this.cache_metrics.savedRedisOps++;
      logger.debug(`In-memory cache hit for key: ${key}`);
      return cachedValue;
    }
    
    // Not in memory cache, check Redis
    if (!this.isAvailable()) {
      logger.debug(`Redis not available, skipping cache GET for key: ${key}`);
      this.cache_metrics.misses++;
      return null;
    }
    
    try {
      const [connection, returnToPool] = this.getConnectionFromPool();
      try {
        const value = await connection.get(key);
        
        // If found in Redis, also cache in memory for future burst requests
        if (value !== null) {
          // Get TTL to set appropriate memory cache expiration
          const ttl = await connection.ttl(key);
          const memoryTtl = ttl > 0 ? Math.min(ttl * 1000, 10000) : 10000; // Max 10s or Redis TTL
          
          this.data_cache.set(key, value, { ttl: memoryTtl });
          logger.debug(`Cached Redis value in memory: ${key} (TTL: ${memoryTtl}ms)`);
        }
        
        this.cache_metrics.misses++;
        return value;
      } finally {
        returnToPool();
      }
    } catch (error) {
      logger.error(`Redis GET error for key: ${key}`, error as Error);
      this.cache_metrics.misses++;
      return null; // Return null instead of throwing to allow fallback to backend
    }
  }

  /**
   * Set a cached value with TTL, updates both Redis and memory cache
   */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    // Invalidate the TTL cache for this key since we're changing it
    this.ttl_cache.delete(key);
    
    // Update in-memory cache with shorter TTL (max 10 seconds)
    const memoryTtl = Math.min(ttlSeconds * 1000, 10000);
    this.data_cache.set(key, value, { ttl: memoryTtl });
    
    if (!this.isAvailable()) {
      logger.debug(`Redis not available, value only stored in memory cache: ${key}`);
      return;
    }
    
    try {
      const [connection, returnToPool] = this.getConnectionFromPool();
      try {
        await connection.set(key, value, 'EX', ttlSeconds);
        logger.debug(`Stored response in Redis and memory cache: ${key}`);
      } finally {
        returnToPool();
      }
    } catch (error) {
      logger.error(`Redis SET error for key: ${key}`, error as Error);
      // No need to throw, just log the error and continue
    }
  }

  /**
   * Get the remaining TTL for a key in seconds
   */
  async getTtl(key: string): Promise<number | undefined> {
    if (!this.isAvailable()) {
      logger.debug(`Redis not available, skipping TTL check for key: ${key}`);
      return undefined;
    }
    
    // Check if we have a cached TTL value
    const cachedTtl = this.ttl_cache.get(key);
    if (cachedTtl !== undefined) {
      logger.debug(`Using cached TTL for key: ${key}`);
      return cachedTtl;
    }
    
    try {
      const [connection, returnToPool] = this.getConnectionFromPool();
      try {
        const ttl = await connection.ttl(key);
        // Redis returns -1 if key exists but has no TTL, -2 if key doesn't exist
        if (ttl >= 0) {
          // Cache the TTL result for 5 seconds to protect against traffic bursts
          this.ttl_cache.set(key, ttl);
          return ttl;
        }
        return undefined;
      } finally {
        returnToPool();
      }
    } catch (error) {
      logger.error(`Redis TTL error for key: ${key}`, error as Error);
      return undefined;
    }
  }

  /**
   * Invalidate a specific key from both Redis and memory cache
   */
  async invalidate(key: string): Promise<boolean> {
    // Always remove from memory cache
    this.data_cache.delete(key);
    this.ttl_cache.delete(key);
    
    if (!this.isAvailable()) {
      logger.debug(`Redis not available, only removed key from memory cache: ${key}`);
      return true;
    }
    
    try {
      const [connection, returnToPool] = this.getConnectionFromPool();
      try {
        const result = await connection.del(key);
        logger.debug(`Invalidated key from Redis and memory: ${key}`);
        return result > 0;
      } finally {
        returnToPool();
      }
    } catch (error) {
      logger.error(`Error invalidating key: ${key}`, error as Error);
      return false;
    }
  }

  /**
   * Scan and delete keys by pattern
   */
  async scanAndDeleteKeys(pattern: string): Promise<number> {
    // Clear the entire memory data cache and TTL cache
    this.data_cache.clear();
    this.ttl_cache.clear();
    
    if (!this.isAvailable()) {
      logger.warn(`Redis not available, skipping cache invalidation for pattern: ${pattern}`);
      return 0;
    }
    
    let cursor = '0';
    let deletedCount = 0;
    const scanBatchSize = 100;

    logger.info(`Scanning for keys matching pattern: ${pattern}`);
    try {
      const [connection, returnToPool] = this.getConnectionFromPool();
      try {
        do {
          const [nextCursor, keys] = await connection.scan(
            cursor, 'MATCH', pattern, 'COUNT', scanBatchSize
          );
          cursor = nextCursor;
          
          if (keys.length > 0) {
            logger.debug(`Found keys to delete in batch: ${keys.join(', ')}`);
            const pipeline = connection.pipeline();
            keys.forEach(key => pipeline.del(key));
            const results = await pipeline.exec();
            deletedCount += results?.filter(
              result => result && result[0] === null && result[1] === 1
            ).length || 0;
          }
        } while (cursor !== '0');
      } finally {
        returnToPool();
      }
      
      logger.info(`Deleted ${deletedCount} keys matching pattern: ${pattern}`);
    } catch (error) {
      logger.error(`Error during cache invalidation scan for pattern: ${pattern}`, error as Error);
    }
    
    return deletedCount;
  }

  /**
   * Get all cache keys
   */
  async getAllCacheKeys(): Promise<string[]> {
    if (!this.isAvailable()) {
      logger.warn('Redis not available, cannot retrieve cache keys');
      return [];
    }
    
    let cursor = '0';
    const allKeys: string[] = [];
    const scanBatchSize = 500;
    const keyLimit = 10000; // Safety limit
    
    logger.info('Scanning for all cache keys (prefix "cache:*")');
    try {
      const [connection, returnToPool] = this.getConnectionFromPool();
      try {
        do {
          const [nextCursor, keys] = await connection.scan(
            cursor, 'MATCH', 'cache:*', 'COUNT', scanBatchSize
          );
          cursor = nextCursor;
          allKeys.push(...keys);
          
          if (allKeys.length > keyLimit) {
            logger.warn(`Reached key limit (${keyLimit}) while scanning. Returning partial results.`);
            break;
          }
        } while (cursor !== '0');
      } finally {
        returnToPool();
      }
      
      logger.info(`Found ${allKeys.length} cache keys.`);
    } catch (error) {
      logger.error('Error scanning for all cache keys', error as Error);
    }
    
    return allKeys;
  }
  
  /**
   * Get current connection pool statistics
   */
  getPoolStats(): Record<string, any> {
    const inUseCount = this.connectionPool.filter(item => item.inUse).length;
    
    // Calculate in-memory cache hit ratio
    const totalCacheRequests = this.cache_metrics.hits + this.cache_metrics.misses;
    const hitRatio = totalCacheRequests > 0 
      ? (this.cache_metrics.hits / totalCacheRequests * 100).toFixed(2)
      : '0.00';
    
    // Reset metrics if they get too large
    if (totalCacheRequests > 1000000) {
      this.resetCacheMetrics();
    }
    
    return {
      poolSize: this.connectionPool.length,
      inUse: inUseCount,
      available: this.connectionPool.length - inUseCount,
      metrics: {
        requests: this.connectionMetrics.requestCount,
        hits: this.connectionMetrics.hitCount,
        misses: this.connectionMetrics.missCount,
        errors: this.connectionMetrics.errorCount,
        avgAcquisitionTimeMs: this.connectionMetrics.avgAcquisitionTime
      },
      memoryCache: {
        size: this.data_cache.size,
        maxSize: this.data_cache.max,
        hits: this.cache_metrics.hits,
        misses: this.cache_metrics.misses,
        hitRatio: `${hitRatio}%`,
        savedRedisOperations: this.cache_metrics.savedRedisOps,
        uptime: Math.floor((Date.now() - this.cache_metrics.lastReset) / 1000)
      },
      connectionAges: this.connectionPool.map(item => ({
        id: item.id,
        ageMs: Date.now() - item.created,
        inUse: item.inUse,
        lastUsedMs: item.lastUsed ? Date.now() - item.lastUsed : null
      }))
    };
  }
  
  /**
   * Reset cache metrics counters
   */
  private resetCacheMetrics(): void {
    logger.info('Resetting memory cache metrics (counters reached high values)');
    this.cache_metrics = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      savedRedisOps: 0,
      lastReset: Date.now()
    };
  }
  
  /**
   * Configure memory cache settings
   */
  configureMemoryCache(options: {
    maxSize?: number;
    ttlMs?: number;
    enabled?: boolean;
  }): void {
    const currentOptions = {
      max: this.data_cache.max,
      ttl: this.data_cache.ttl,
      enabled: true
    };
    
    // Apply new options
    if (options.maxSize !== undefined && options.maxSize >= 0) {
      if (options.maxSize === 0) {
        // Disable cache if max size is 0
        this.data_cache.clear();
        currentOptions.enabled = false;
      } else {
        currentOptions.max = options.maxSize;
        currentOptions.enabled = true;
      }
    }
    
    if (options.ttlMs !== undefined && options.ttlMs >= 0) {
      currentOptions.ttl = options.ttlMs;
    }
    
    if (options.enabled !== undefined) {
      currentOptions.enabled = options.enabled;
      if (!options.enabled) {
        this.data_cache.clear();
      }
    }
    
    // Create a new cache with the updated settings
    if (currentOptions.enabled) {
      this.data_cache = new LRUCache<string, string>({
        max: currentOptions.max,
        ttl: currentOptions.ttl,
        updateAgeOnGet: true,
        allowStale: false
      });
    }
    
    logger.info(`Memory cache reconfigured: max=${currentOptions.max}, ttl=${currentOptions.ttl}ms, enabled=${currentOptions.enabled}`);
  }
  
  /**
   * Closes all pool connections and the main client
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Redis connections');
    
    // Clear in-memory caches
    this.data_cache.clear();
    this.ttl_cache.clear();
    
    // Close all pool connections
    const poolClosePromises = this.connectionPool.map(item => 
      item.connection.quit().catch(err => 
        logger.error(`Error closing Redis pool connection ${item.id}`, err)
      )
    );
    
    // Close main client
    const mainClientClose = this.client.quit().catch(err => 
      logger.error('Error closing main Redis connection', err)
    );
    
    try {
      await Promise.all([...poolClosePromises, mainClientClose]);
      logger.info('All Redis connections closed');
    } catch (error) {
      logger.error('Error during Redis shutdown', error as Error);
    }
  }
}

// Export singleton instance
export const redisService = new RedisService();