import fs from 'fs/promises';
import { Request } from 'express';
import { InvalidationRule } from '../types';
import { config } from '../config/config';
import { logger } from './logger.service';
import { cacheService } from './cache.service';

class InvalidationService {
  private invalidationRules: InvalidationRule[] = [];
  
  constructor() {
    this.loadInvalidationRules().catch(err => 
      logger.error('Failed to load initial invalidation rules', err));
  }

  /**
   * Loads invalidation rules from config file
   */
  async loadInvalidationRules(): Promise<InvalidationRule[]> {
    try {
      const data = await fs.readFile(config.invalidationConfigPath, 'utf-8');
      this.invalidationRules = JSON.parse(data);
      logger.info(`Loaded ${this.invalidationRules.length} invalidation rules`);
      return this.invalidationRules;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(`Invalidation config file not found. POST-based invalidation disabled.`);
        return [];
      }
      logger.error(`Error loading invalidation config`, error as Error);
      return [];
    }
  }

  /**
   * Handles cache invalidation for POST requests
   */
  async handlePostRequestInvalidation(req: Request): Promise<void> {
    if (this.invalidationRules.length === 0) {
      return; // No rules to process
    }

    const requestPath = cacheService.getNormalizedPath(req);

    for (const rule of this.invalidationRules) {
      try {
        const pathRegex = new RegExp(rule.post_path_regex);
        const match = requestPath.match(pathRegex);

        if (match) {
          logger.info(`POST to ${requestPath} matched invalidation rule: ${rule.post_path_regex}`);
          
          // Resolve patterns with regex group replacements
          const patternsToInvalidate = rule.invalidate_patterns.map(pattern => {
            let resolvedPattern = pattern;
            if (match.length > 1) {
              for (let i = 1; i < match.length; i++) {
                resolvedPattern = resolvedPattern.replace(new RegExp(`\\$${i}`, 'g'), match[i]);
              }
            }
            
            // Modify pattern to include wildcard for role
            // This ensures all role variants of a cache entry are invalidated
            const parts = resolvedPattern.split(':');
            if (parts.length >= 2) {
              return `${parts[0]}:${parts[1]}:*:${parts.slice(2).join(':')}`;
            }
            return resolvedPattern;
          });

          // Run invalidations in parallel
          const invalidationPromises = patternsToInvalidate.map(pattern => 
            cacheService.invalidateCache(pattern)
              .catch(err => logger.error(`Error invalidating pattern: ${pattern}`, err))
          );
          
          // Don't await, let it run in background
          Promise.all(invalidationPromises)
            .catch(err => logger.error('Error in invalidation promises', err));
        }
      } catch (error) {
        logger.error(`Error processing invalidation rule: ${rule.post_path_regex}`, error as Error);
      }
    }
  }

  /**
   * Manually invalidate cache by pattern
   */
  async invalidateByPattern(pattern: string): Promise<number> {
    return await cacheService.invalidateCache(pattern);
  }
}

// Export singleton instance
export const invalidationService = new InvalidationService();
