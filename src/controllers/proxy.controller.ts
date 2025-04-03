import { Request, Response, NextFunction } from 'express';
import { cacheService } from '../services/cache.service';
import { proxyService, ProxyResult } from '../services/proxy.service';
import { invalidationService } from '../services/invalidation.service';
import { logger } from '../services/logger.service';

export class ProxyController {
  /**
   * Main handler for all proxy requests
   */
  async handleRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    const method = req.method;

    try {
      // For GET requests, try to serve from cache
      if (method === 'GET') {
        const cacheResult = await cacheService.getFromCache(req);
        
        if (cacheResult.hit && cacheResult.data) {
          // Serve directly from cache
          logger.info(`Serving from cache: ${req.originalUrl}`);
          
          // Set status from cache
          res.status(cacheResult.data.status);
          
          // Set headers from cache
          for (const [key, value] of Object.entries(cacheResult.data.headers)) {
            res.setHeader(key, value);
          }
          
          // Add cache status header
          res.setHeader('X-Cache-Status', cacheResult.status);
          
          // Add cache expiration headers if TTL is available
          if (cacheResult.ttlRemaining !== undefined) {
            const expiresAt = new Date(Date.now() + cacheResult.ttlRemaining * 1000);
            res.setHeader('X-Cache-Expires-In', `${Math.floor(cacheResult.ttlRemaining)}s`);
            res.setHeader('X-Cache-Expires-At', expiresAt.toISOString());
          }
          
          // Send the cached body
          res.send(cacheResult.data.body);
          return;
        }
        
        // If not in cache or bypass requested, proxy the request
        await proxyService.proxyRequest(req, res, cacheResult.status);
      } else {
        // Non-GET request, always proxy
        // Check for POST-based invalidation after successful proxying
        const proxyResult: ProxyResult | undefined = await proxyService.proxyRequest(req, res, 'N/A');
        
        // Only process invalidation if proxyResult exists and has statusCode
        if (method === 'POST' && proxyResult && proxyResult.statusCode >= 200 && proxyResult.statusCode < 300) {
          // Don't await - let it run in background
          invalidationService.handlePostRequestInvalidation(req).catch(err => {
            logger.error('Error during POST-based cache invalidation', err);
          });
        }
      }
    } catch (error) {
      logger.error(`Error handling ${method} request to ${req.originalUrl}`, error as Error);
      next(error);
    }
  }
}

// Export singleton instance
export const proxyController = new ProxyController();
