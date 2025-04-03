import pino from 'pino';
import { config } from '../config/config';

class LoggerService {
  private logger: pino.Logger;

  constructor() {
    // Basic configuration that works with pino v9.6.0
    this.logger = pino({
      level: config.logLevel
    });
  }

  info(message: string, obj?: Record<string, any>): void {
    this.logger.info(obj || {}, message);
  }

  debug(message: string, obj?: Record<string, any>): void {
    this.logger.debug(obj || {}, message);
  }

  warn(message: string, obj?: Record<string, any>): void {
    this.logger.warn(obj || {}, message);
  }

  error(message: string, error?: Error, obj?: Record<string, any>): void {
    this.logger.error({ err: error, ...obj }, message);
  }

  /**
   * Returns the raw pino logger instance
   */
  getInstance(): pino.Logger {
    return this.logger;
  }
}

// Export singleton instance
export const logger = new LoggerService();
