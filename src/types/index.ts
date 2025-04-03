import { Redis } from 'ioredis';
import { Logger } from 'pino';

/**
 * Represents the structure of a cached response stored in Redis.
 */
export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  // Replace the base64 string with a Buffer
  body: Buffer;
}

/**
 * Defines a rule for invalidating cache entries based on POST requests.
 */
export interface InvalidationRule {
  post_path_regex: string;
  invalidate_patterns: string[];
}

/**
 * Application state shared across modules.
 */
export interface AppState {
  redisClient: Redis;
  logger: Logger;
}

/**
 * Response from cache operations
 */
export interface CacheResult {
  hit: boolean;
  status: string;
  data?: CachedResponse;
  ttlRemaining?: number;  // Time-to-live in seconds
}
