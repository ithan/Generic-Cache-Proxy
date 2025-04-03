import express, { Application, Request } from 'express';
import pinoHttp from 'pino-http';
import { logger } from './services/logger.service';
import { errorHandler } from './middleware/error.middleware';
import { metricsMiddleware } from './middleware/metrics.middleware';
import { adminRoutes } from './routes/admin.routes';
import { proxyRoutes } from './routes/proxy.routes';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function createApp(): Application {
  const app = express();
  
  // Request logging middleware (must be early)
  app.use(pinoHttp({ 
    logger: logger.getInstance(),
    // Only log warnings and errors to reduce overhead
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 400 || err) {
        return 'warn';
      }
      return 'debug'; // This won't be logged if level is set to 'warn'
    }
  }));
  
  // Global JSON body parser for JSON requests
  app.use(express.json({ 
    type: ['application/json'],
    limit: '1mb'
  }));
  
  // Create the raw body parser middleware ONCE instead of on every request
  const rawBodyParser = express.raw({ 
    type: '*/*', 
    limit: '10mb',
    verify: (req: Request, res, buf) => {
      // Store raw body for requests that need it
      if (!req.headers['content-type']?.includes('application/json')) {
        (req as Express.Request).rawBody = buf;
      }
    }
  });
  
  // Apply raw body parser only for methods that need it
  app.use((req, res, next) => {
    const method = req.method;
    if (method === 'GET' || method === 'HEAD') {
      // Skip raw body parsing for GET/HEAD requests
      next();
    } else {
      // Use the pre-created middleware for non-GET/HEAD requests
      rawBodyParser(req, res, next);
    }
  });
  
  // Metrics middleware to record request stats
  app.use(metricsMiddleware);
  
  // Admin routes
  app.use('/', adminRoutes);
  
  // Proxy routes (must be last as it includes catch-all)
  app.use('/', proxyRoutes);
  
  // Global error handler
  app.use(errorHandler);
  
  return app;
}