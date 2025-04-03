import { Request, Response, NextFunction } from 'express';
import { metricsService } from '../services/metrics.service';
import { cacheService } from '../services/cache.service';
import { authService } from '../services/auth.service';

const pathNormalizeCache = new Map<string, string>();
const PATH_CACHE_MAX_SIZE = 3000;
const ADMIN_ROUTES = new Set(['/metrics', '/keys', '/health', '/invalidate', '/key']);

/**
 * Normalizes a request path for consistent metrics tracking
 * Keeps important path structure but removes dynamic parameters
 */
function normalizePathForMetrics(req: Request): string {

  if (req.route?.path && ADMIN_ROUTES.has(req.route.path)) {
    return req.route.path;
  }


  // Get the original path from the request
  const originalPath = req.originalUrl || req.url;
  
  if (pathNormalizeCache.has(originalPath)) {
    return pathNormalizeCache.get(originalPath)!;
  }
  
  try {
    // Parse the URL to separate path from query parameters
    const url = new URL(originalPath, `http://localhost`);
    const path = url.pathname;
    
    // Normalize API paths to maintain structure but remove specific IDs
    // Example patterns:
    // 1. /api/v1/articles/123 -> /api/v1/articles/:id
    // 2. /api/v1/steps?lng=en&per_page=1&page=1 -> /api/v1/steps
    
    // Match common API path patterns
    const apiPathMatch = path.match(/^(\/api\/v\d+\/[^\/]+)(\/.*)?$/);
    if (apiPathMatch) {
      const basePath = apiPathMatch[1]; // e.g., /api/v1/articles
      
      // Check if there's a specific ID pattern after the base resource
      const subPath = apiPathMatch[2];
      if (subPath && /^\/\d+/.test(subPath)) {
        return `${basePath}/:id`;
      }
      
      // Return the base API path
      return basePath;
    }
    
    // its caching time
    if (pathNormalizeCache.size >= PATH_CACHE_MAX_SIZE) {
      // clear 20% of the cache
      const keysToDelete = Array.from(pathNormalizeCache.keys()).slice(0, Math.floor(PATH_CACHE_MAX_SIZE * 0.2));
      for (const key of keysToDelete) {
        pathNormalizeCache.delete(key);
      }
    }

    // Cache the normalized path for future requests
    pathNormalizeCache.set(originalPath, path);

    // If no specific normalization applies, return the pathname without query params
    return path;
  } catch (e) {
    // Fallback in case of parsing errors
    return cacheService.getNormalizedPath(req);
  }
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Record start time
  const startTime = process.hrtime();

  // Add listener for 'finish' event to record metrics after response is sent
  res.on('finish', () => {
    const durationComponents = process.hrtime(startTime);
    const durationSeconds = durationComponents[0] + durationComponents[1] / 1e9;
    
    // Get method and path
    const method = req.method;
    
    // Get normalized path for metrics using our enhanced function
    const pathLabel = normalizePathForMetrics(req);
    
    // Get status code and cache header
    const statusCode = res.statusCode;
    const cacheStatusLabel = String(res.getHeader('X-Cache-Status') || 'N/A');
    
    // Get user role information
    const userRole = authService.getUserRoleIdentifier(req);

    // Record metrics with user role information
    metricsService.recordRequestMetrics(
      method,
      pathLabel,
      statusCode,
      cacheStatusLabel,
      durationSeconds,
      userRole
    );
  });

  next();
}
