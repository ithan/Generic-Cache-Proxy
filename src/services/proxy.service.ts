import { Request, Response } from 'express';
import { config } from '../config/config';
import { logger } from './logger.service';
import { cacheService } from './cache.service';
import * as http from 'http';
import * as https from 'https';
import axios, { AxiosInstance } from 'axios';
import { AxiosRequestConfig, AxiosResponse } from 'axios';

// Define a return type for proxyRequest
export interface ProxyResult {
  statusCode: number;
  headers?: Record<string, string>;
  // Add any other fields that might be useful
}

// Pre-defined constants to avoid object creation and lookups - with proper typing
const SKIP_HEADERS: Record<string, boolean> = {
  'host': true, 
  'connection': true, 
  'transfer-encoding': true, 
  'keep-alive': true, 
  'content-length': true
};

const CACHE_HEADERS: Record<string, boolean> = {
  'content-type': true, 
  'content-disposition': true, 
  'cache-control': true
};

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

// Type for error code mapping
interface ErrorCodeInfo {
  status: number;
  message: string;
}

/**
 * Interface for tracking in-flight requests
 */
interface InFlightRequest {
  promise: Promise<ProxyResult | undefined>;
  timestamp: number;
}

class ProxyService {
  // Create persistent HTTP and HTTPS agents with keepAlive enabled
  // Optimized for high traffic scenarios
  private readonly httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000, // 30 seconds
    maxSockets: 100, // Higher number for high traffic
    timeout: 60000, // 60 seconds socket timeout
    scheduling: 'fifo' // FIFO is better for high traffic scenarios
  });
  
  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100,
    timeout: 60000,
    scheduling: 'fifo'
  });

  // Pre-configured axios instance for better performance
  private readonly axiosInstance: AxiosInstance = axios.create({
    timeout: 150000, // 150 seconds
    maxRedirects: 5,
    validateStatus: null, // Allow all status codes to be processed
    withCredentials: true, // Similar to credentials: 'include'
  });

  // Map to track in-flight requests to prevent duplicate backend calls
  private readonly in_flight_requests = new Map<string, InFlightRequest>();
  private readonly in_flight_max_age = 60000; // 60 seconds max wait time

  private timeout_id: NodeJS.Timeout | null = null;
  private readonly cleanup_interval: number = 30000; // 30 seconds

  constructor() {
    this.start_cleanup_interval();
  }
  
  // Pre-defined error mappings to avoid conditionals - with proper typing
  private readonly ERROR_CODES: Record<string, ErrorCodeInfo> = {
    'ECONNREFUSED': { status: 502, message: 'Bad Gateway - Cannot connect to backend service.' },
    'ENOTFOUND': { status: 502, message: 'Bad Gateway - Cannot connect to backend service.' },
    'ECONNRESET': { status: 504, message: 'Gateway Timeout - Error communicating with backend service.' },
    'ETIMEDOUT': { status: 504, message: 'Gateway Timeout - Error communicating with backend service.' },
    'ECONNABORTED': { status: 504, message: 'Gateway Timeout - Error communicating with backend service.' }
  };
  
  /**
   * Starts the interval for cleaning up stale in-flight requests
   * This prevents memory leaks from orphaned requests
   */
  private start_cleanup_interval(): void {
    if (this.timeout_id) return; // Already running

    this.timeout_id = setInterval(() => {
      const now = Date.now();
      for (const [key, request] of this.in_flight_requests.entries()) {
        if (now - request.timestamp > this.in_flight_max_age) {
          this.in_flight_requests.delete(key);
          logger.debug(`Cleaned up stale in-flight request: ${key}`);
        }
      }
    }, this.cleanup_interval);
  }

  /**
   * Generates a unique key for in-flight request tracking
   * The key includes method, URL, and relevant cache-affecting headers
   */
  private generate_request_key(req: Request, cacheStatus: string): string {
    const method = req.method || 'GET';
    const url = req.originalUrl;
    
    // Include cache-related headers that would affect the response
    const cache_control = req.headers['cache-control'] || '';
    const pragma = req.headers.pragma || '';
    const cache_refresh = req.headers['cache-refresh'] || req.headers['x-cache-refresh'] || '';
    
    // Build a unique key that incorporates all elements that would make this request unique
    return `${method}|${url}|${cache_control}|${pragma}|${cache_refresh}|${cacheStatus}`;
  }

  /**
   * Forwards request to backend and handles the response
   * @returns A Promise that resolves to a ProxyResult or undefined if the response couldn't be sent
   */
  async proxyRequest(
    req: Request, 
    res: Response, 
    cacheStatus: string
  ): Promise<ProxyResult | undefined> {
    // Fast cache-busting detection
    let refresh_cache = false;
    const cacheControl = req.headers['cache-control'];
    const pragma = req.headers.pragma;
    
    if (cacheStatus === 'HIT') {
      if (cacheControl) {
        const cc = cacheControl as string;
        if (cc.includes('no-cache') || cc.includes('max-age=0')) {
          refresh_cache = true;
        }
      }
      if (!refresh_cache && pragma && (pragma as string).includes('no-cache')) {
        refresh_cache = true;
      }
      if (!refresh_cache && (req.headers['cache-refresh'] === 'true' || req.headers['x-cache-refresh'] === 'true')) {
        refresh_cache = true;
      }
      
      if (refresh_cache) {
        logger.debug('Cache-busting headers detected, refreshing cache');
        cacheStatus = 'REFRESH'; // Mark for refresh but will still store the new response
      }
    }

    const method = req.method;
    const targetUrl = `${config.backendUrl}${req.originalUrl}`;
    
    // Generate a unique key for this request to track in-flight status
    const request_key = this.generate_request_key(req, cacheStatus);
    
    // Check if an identical request is already in flight
    const existing_request = this.in_flight_requests.get(request_key);
    if (existing_request) {
      logger.debug(`Using in-flight request for: ${request_key}`);
      
      // Reuse the existing promise for this request
      try {
        // Wait for the in-flight request to complete
        const result = await existing_request.promise;
        
        // If the original request failed, we shouldn't try to use its result
        if (!result) {
          logger.debug(`In-flight request failed for: ${request_key}`);
          return undefined;
        }
        
        // Apply the result to this response if headers haven't been sent
        if (!res.headersSent) {
          // Set status code from the original response
          res.status(result.statusCode);
          
          // Apply headers from the original response
          if (result.headers) {
            for (const [key, value] of Object.entries(result.headers)) {
              res.setHeader(key, value);
            }
          }
          
          // Set a header to indicate this was a shared in-flight response
          res.setHeader('X-Shared-Response', 'true');
          
          // We can't send the body as it was already consumed by the first request
          // Instead, we'll send a message indicating this was a shared response
          res.send('Response shared with a concurrent request');
        }
        
        return result;
      } catch (error) {
        // If the in-flight request failed, we'll make a new request
        logger.error(`Error waiting for in-flight request: ${(error as Error).message}`);
        // Continue to make a new request
      }
    }

    // Log only when needed (could be made conditional for production)
    logger.info(`Proxying ${method} request to: ${targetUrl}`);

    // Create a new promise for this request
    const request_promise = this.execute_proxy_request(req, res, cacheStatus, targetUrl);
    
    // Store this request in the in-flight map
    this.in_flight_requests.set(request_key, {
      promise: request_promise,
      timestamp: Date.now()
    });
    
    try {
      // Wait for the request to complete
      const result = await request_promise;
      
      // Remove from in-flight map once completed
      this.in_flight_requests.delete(request_key);
      
      return result;
    } catch (error) {
      // Make sure to remove from in-flight map on error
      this.in_flight_requests.delete(request_key);
      throw error;
    }
  }
  
  /**
   * Executes the actual proxy request to the backend service
   * Separated from proxyRequest to allow for in-flight request tracking
   */
  private async execute_proxy_request(
    req: Request,
    res: Response,
    cacheStatus: string,
    targetUrl: string
  ): Promise<ProxyResult | undefined> {
    const method = req.method;
    
    // Prepare headers to forward - optimized version
    const headersToForward: Record<string, string> = {};
    
    // Fast headers iteration
    const reqHeaders = req.headers;
    for (const key in reqHeaders) {
      const value = reqHeaders[key];
      if (!value) continue;
      
      // Skip headers that should be excluded - with type-safe check
      const lowerKey = key.toLowerCase();
      if (SKIP_HEADERS[lowerKey] === true) continue;
      
      // Fast cast to string
      if (typeof value === 'string') {
        headersToForward[key] = value;
      } else if (Array.isArray(value)) {
        headersToForward[key] = value.join(', ');
      }
    }
    
    // Add forwarded headers efficiently
    if (req.ip) {
      headersToForward['X-Forwarded-For'] = req.ip;
    }
    
    try {
      // Determine if backend uses HTTPS or HTTP - do this once
      const isHttps = targetUrl.startsWith('https://');
      
      // Configure axios request - reuse config structure
      const axiosConfig: AxiosRequestConfig = {
        method: method as any,
        url: targetUrl,
        headers: headersToForward,
        responseType: 'arraybuffer',
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent
      };
      
      // Only include body for methods that support it
      if (method !== 'GET' && method !== 'HEAD') {
        // Efficient body handling
        const rawBody = req.rawBody;
        if (rawBody) {
          axiosConfig.data = rawBody;
        } else if (req.body instanceof Buffer) {
          axiosConfig.data = req.body;
        } else if (req.body) {
          axiosConfig.data = Buffer.from(JSON.stringify(req.body));
        }
      }
      
      // Minimal logging for performance - conditional for production
      if (process.env.NODE_ENV !== 'production') {
        logger.debug(`Proxy request: ${method} ${targetUrl} (${Object.keys(headersToForward).length} headers)`);
      }
      
      // Make the backend request with the pre-configured instance
      const backendResponse: AxiosResponse = await this.axiosInstance(axiosConfig);
      
      // Set status from backend - simple operation
      res.status(backendResponse.status);

      // Efficient header handling
      const headersToCache: Record<string, string> = {};
      const responseHeaders = backendResponse.headers;
      
      for (const key in responseHeaders) {
        const lowerKey = key.toLowerCase();
        
        // Skip headers that should be excluded - with type-safe check
        if (SKIP_HEADERS[lowerKey] === true) continue;
        
        const value = responseHeaders[key];
        // Efficient conversion to string
        const headerValue = typeof value === 'string' ? value : 
                           Array.isArray(value) ? value.join(', ') : String(value);
        
        // Set header directly
        res.setHeader(key, headerValue);
        
        // Save important headers for caching - use lookup table with type-safe check
        if (CACHE_HEADERS[lowerKey] === true) {
          headersToCache[key] = headerValue;
        }
      }

      // Optimized cache condition checking
      const isCacheableMethod = method === 'GET';
      const isCacheableStatus = backendResponse.status >= HTTP_OK_MIN && backendResponse.status < HTTP_OK_MAX;
      const shouldStoreInCache = isCacheableMethod && isCacheableStatus && 
                              (cacheStatus === 'REFRESH' || !(cacheStatus === 'HIT' || cacheStatus === 'BYPASS'));

      // Add cache status header
      res.setHeader('X-Cache-Status', cacheStatus);

      // Cache info headers - only set when needed
      if (shouldStoreInCache) {
        const cacheTtl = config.cacheTtlSeconds;
        res.setHeader('X-Cache-Expires-In', `${cacheTtl} seconds`);
        
        // Calculate expiration time efficiently
        const expiresAt = new Date(Date.now() + (cacheTtl * 1000));
        res.setHeader('X-Cache-Expires-At', expiresAt.toISOString());
      }

      // Get response data directly without extra Buffer creation when possible
      const responseBuffer = backendResponse.data instanceof Buffer ? 
                           backendResponse.data : 
                           Buffer.from(backendResponse.data);

      // Send to client
      res.send(responseBuffer);

      // Store in cache if applicable - don't await
      if (shouldStoreInCache) {
        // Fire and forget - no await
        cacheService.storeInCache(req, backendResponse.status, headersToCache, responseBuffer)
          .catch(err => logger.error('Cache error:', err.message));
      }

      // Return the result with status code
      return {
        statusCode: backendResponse.status,
        headers: headersToCache
      };
    } catch (error: any) {
      this.handleProxyError(error, req, res, cacheStatus);
      return undefined;
    }
  }

  /**
   * Handles errors during proxying - optimized version
   */
  private handleProxyError(error: any, req: Request, res: Response, cacheStatus: string): void {
    // Minimal error logging
    logger.error(`Proxy error: ${req.method} ${req.originalUrl} - ${error.message || 'Unknown error'}`);

    // Don't override cache status if already set
    if (!res.getHeader('X-Cache-Status')) {
      res.setHeader('X-Cache-Status', 'ERROR');
    }

    // Default error state
    let statusCode = 500;
    let errorMessage = 'Internal Server Error during proxying.';

    // Fast error handling using pre-defined mappings
    if (error.response) {
      // The request was made and the server responded with a status code outside 2xx
      statusCode = error.response.status;
      errorMessage = `Error ${statusCode} from backend service`;
    } else if (error.request) {
      // The request was made but no response was received
      const errorCode = error.code;
      if (errorCode && this.ERROR_CODES[errorCode]) {
        const errorInfo = this.ERROR_CODES[errorCode];
        statusCode = errorInfo.status;
        errorMessage = errorInfo.message;
      }
    } else if (error.message && error.message.includes('body') && 
              (req.method === 'GET' || req.method === 'HEAD')) {
      errorMessage = 'Invalid request: GET/HEAD requests cannot have a body';
    }

    // Send error response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(statusCode).json({ error: errorMessage });
    } else {
      // Try to end the response
      try {
        res.end();
      } catch (endError) {
        // Just log the message to avoid object creation
        logger.error(`Error ending response: ${(endError as Error).message}`);
      }
    }
  }
}

// Export singleton instance
export const proxyService = new ProxyService();