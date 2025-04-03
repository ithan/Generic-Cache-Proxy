import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';

export function errorHandler(
  err: Error, 
  req: Request, 
  res: Response, 
  next: NextFunction
): void {
  logger.error(`Unhandled error occurred: ${err.message}`, err);

  // Check if headers were already sent
  if (res.headersSent) {
    // Delegate to default Express error handler which closes the connection
    return next(err);
  }

  // Send generic error response
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}
