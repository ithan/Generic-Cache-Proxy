import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config();

/**
 * Application configuration loaded from environment variables.
 */
export interface AppConfig {
  port: number;
  logLevel: string;
  cacheUrl: string;
  backendUrl: string;
  cacheTtlSeconds: number;
  invalidationConfigPath: string;
}

/**
 * Loads configuration from environment variables.
 * Exits process if required variables are missing.
 */
export function loadConfig(): AppConfig {
  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    cacheUrl: process.env.CACHE_URL || '',
    backendUrl: process.env.BACKEND_URL || '',
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '1800', 10),
    invalidationConfigPath: path.join(process.cwd(), 'invalidation_config.json'),
  };

  // Check for required configurations after providing defaults to satisfy TypeScript
  if (!config.cacheUrl || !config.backendUrl) {
    console.error('Error: CACHE_URL and BACKEND_URL environment variables are required.');
    process.exit(1);
  }

  // Verify invalidation config file exists
  try {
    fs.accessSync(config.invalidationConfigPath, fs.constants.R_OK);
  } catch (error) {
    console.warn(`Invalidation config file not found at ${config.invalidationConfigPath}. Creating default empty config.`);
    try {
      fs.writeFileSync(config.invalidationConfigPath, JSON.stringify([], null, 2));
    } catch (writeError) {
      console.warn(`Could not create default invalidation config: ${writeError}`);
    }
  }

  return config;
}

// Export singleton instance
export const config = loadConfig();
