import { Request, Response } from 'express';
import { metricsService } from '../services/metrics.service';
import { cacheService } from '../services/cache.service';
import { invalidationService } from '../services/invalidation.service';
import { logger } from '../services/logger.service';

export class AdminController {
  /**
   * GET /metrics - Returns Prometheus metrics
   */
  async getMetrics(req: Request, res: Response): Promise<void> {
    try {
      res.set('Content-Type', metricsService.register.contentType);
      const metrics = await metricsService.getMetrics();
      res.send(metrics);
    } catch (error) {
      logger.error('Failed to collect metrics', error as Error);
      res.status(500).json({ error: 'Error collecting metrics' });
    }
  }

  /**
   * POST /invalidate - Invalidate cache by pattern
   */
  async invalidateCache(req: Request, res: Response): Promise<void> {
    const { pattern } = req.body;

    logger.debug(`Received invalidation request with body:`, { body: req.body });

    if (!pattern || typeof pattern !== 'string' || pattern.trim() === '') {
      logger.warn('Invalid invalidation pattern received', {
        body: req.body,
        contentType: req.headers['content-type']
      });
      res.status(400).json({ error: 'Missing or invalid "pattern" in request body' });
      return;
    }

    try {
      logger.info(`Received invalidation request for pattern: ${pattern}`);
      const deletedCount = await invalidationService.invalidateByPattern(pattern);
      res.json({
        message: `Invalidation process completed for pattern: ${pattern}`,
        deletedCount
      });
    } catch (error) {
      logger.error(`Error invalidating pattern: ${pattern}`, error as Error);
      res.status(500).json({ error: 'Error during cache invalidation' });
    }
  }

  /**
   * POST /key - Get cache entry by key
   * This is a debugging endpoint and should be used with caution.
   * 
   */
  async getByKey(req: Request, res: Response): Promise<void> {
    const { key } = req.body;

    logger.debug(`Received request to get cache entry by key:`, { body: req.body });

    if (!key || typeof key !== 'string' || key.trim() === '') {
      logger.warn('Invalid cache key received', {
        body: req.body,
        contentType: req.headers['content-type']
      });
      res.status(400).json({ error: 'Missing or invalid "key" in request body' });
      return;
    }

    const cacheKey = key.trim();
    try {
      logger.info(`Received request to get cache entry by key: ${cacheKey}`);
      const cacheEntry = await cacheService.getByKey(cacheKey);

      if (cacheEntry) {
        res.json({
          message: `Cache entry retrieved for key: ${cacheKey}`,
          cacheEntry
        });
      } else {
        res.status(404).json({
          message: `Cache entry not found for key: ${cacheKey}`
        });
      }
    }
    catch (error) {
      logger.error(`Error retrieving cache entry for key: ${cacheKey}`, error as Error);
      res.status(500).json({ error: 'Error retrieving cache entry' });
    }
  }

  /**
   * GET /keys - List all cache keys
   */
  async listCacheKeys(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Received request to list cache keys');
      const keys = await cacheService.getAllKeys();

      // Update cache keys metric
      metricsService.updateCacheKeysCount(keys.length);

      // Group keys by role for better visibility
      const keysByRole: Record<string, string[]> = {};
      keys.forEach(key => {
        const parts = key.split(':');
        if (parts.length >= 3) {
          const role = parts[2];
          if (!keysByRole[role]) {
            keysByRole[role] = [];
          }
          keysByRole[role].push(key);
        } else {
          // Handle keys without role information (legacy format)
          const role = 'legacy';
          if (!keysByRole[role]) {
            keysByRole[role] = [];
          }
          keysByRole[role].push(key);
        }
      });

      res.json({
        keyCount: keys.length,
        keysByRole,
        keys
      });
    } catch (error) {
      logger.error('Error listing cache keys', error as Error);
      res.status(500).json({ error: 'Error listing cache keys' });
    }
  }

  /**
   * GET /health - Basic health check
   */
  async healthCheck(req: Request, res: Response): Promise<void> {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString()
    });
  }
}

// Export singleton instance
export const adminController = new AdminController();
