import { createApp } from './app';
import { config } from './config/config';
import { logger } from './services/logger.service';
import { redisService } from './services/redis.service';
import { invalidationService } from './services/invalidation.service';

async function startServer(): Promise<void> {
  try {
    // Create express app
    const app = createApp();
    
    // Start HTTP server
    const server = app.listen(config.port, '0.0.0.0', () => {
      logger.info(`Express Caching Proxy listening on port ${config.port}`);
      logger.info(`Log Level: ${config.logLevel}`);
      logger.info(`Proxying to backend: ${config.backendUrl}`);
      logger.info(`Cache TTL: ${config.cacheTtlSeconds} seconds`);
      
      // Log cache URL without credentials if present
      const redactedCacheUrl = config.cacheUrl.includes('@') 
        ? `redis://***:***@${config.cacheUrl.split('@').pop()}`
        : config.cacheUrl;
      logger.info(`Using cache: ${redactedCacheUrl}`);
    });
    
    // Handle shutdown gracefully
    const shutdownHandler = async () => {
      logger.info('Shutdown signal received, closing server...');
      
      server.close(() => {
        logger.info('HTTP server closed');
      });
      
      // Close Redis connections
      const redisClient = redisService.getClient();
      if (redisClient) {
        await redisClient.quit();
        logger.info('Redis connections closed');
      }
      
      logger.info('Shutdown complete');
      process.exit(0);
    };
    
    // Register shutdown handlers
    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);
    
  } catch (error) {
    logger.error('Failed to start server', error as Error);
    process.exit(1);
  }
}

// Start the server
startServer().catch(err => {
  console.error('Unhandled error during startup:', err);
  process.exit(1);
});
