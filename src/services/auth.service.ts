import { Request } from 'express';
import { logger } from './logger.service';
import { LRUCache } from 'lru-cache'
export interface JwtPayload {
  roles?: string[];
  isEmployee?: boolean;
  [key: string]: any;
}



class AuthService {
  
  /**
   * Cache for decoded JWT tokens to avoid repeated decoding
   * This is a simple in-memory cache with a TTL for each entry
   */
  private tokenCache = new LRUCache<string, JwtPayload>({
    max: 1000,
    ttl: 1000 * 60 * 5 // 5 minutes
  });
  
  /**
   * Extracts JWT token from Authorization header
   */
  extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    
    // Use a constant for the prefix to avoid creating new strings each time
    const BEARER_PREFIX = 'Bearer ';
    return authHeader.startsWith(BEARER_PREFIX) ? 
      authHeader.slice(BEARER_PREFIX.length) : null;
  }

  /**
   * Decodes JWT token without verifying signature
   * Note: This is intentionally not verifying the signature as we're only using it for caching purposes
   */
  decodeToken(token: string): JwtPayload | null {
    // Check cache first
    const cached = this.tokenCache.get(token);
    if (cached) return cached;
    
    try {
      // Existing decode logic
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      // Cache the result
      this.tokenCache.set(token, payload);
      return payload;
    } catch (error) {
      logger.error('Error decoding JWT token', error as Error);
      return null;
    }
  }

  /**
   * Gets user roles from request
   * Returns a normalized role identifier for caching purposes
   */
  getUserRoleIdentifier(req: Request): string {
    const token = this.extractToken(req);
    if (!token) {
      return 'anonymous';
    }

    const payload = this.decodeToken(token);
    if (!payload) {
      return 'anonymous';
    }

    // Handle different role scenarios
    if (payload.roles && Array.isArray(payload.roles) && payload.roles.length > 0) {
      // Sort roles to ensure consistent cache keys regardless of role order in token
      const sortedRoles = [...payload.roles].sort();
      
      // Check for administrator role
      if (sortedRoles.includes('administrator')) {
        return 'admin';
      }
      
      // Return all roles concatenated for other role combinations
      return sortedRoles.join('-');
    }

    // Default for authenticated users without specific roles
    return 'authenticated';
  }
}

// Export singleton instance
export const authService = new AuthService();
