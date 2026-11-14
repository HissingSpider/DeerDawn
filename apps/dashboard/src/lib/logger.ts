/**
 * Centralized logging utility for production-safe error handling
 *
 * In production: Suppresses console output and optionally sends to API
 * In development: Logs to console for debugging
 *
 * Zero-cost solution - errors are sent to your own API endpoint
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

interface LogContext {
  [key: string]: any;
}

class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development';
  private apiUrl = (() => {
    const raw = (process.env.NEXT_PUBLIC_API_URL || '').trim();
    if (!raw) return 'https://api.deerdawn.com';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw.replace(/\/$/, '');
    if (raw.startsWith('/')) return raw.replace(/\/$/, '');
    const isLocal = raw.startsWith('localhost') || raw.startsWith('127.0.0.1') || raw.startsWith('0.0.0.0');
    const scheme = isLocal ? 'http://' : 'https://';
    return `${scheme}${raw}`.replace(/\/$/, '');
  })();
  private enableApiLogging = process.env.NEXT_PUBLIC_ENABLE_ERROR_LOGGING === 'true';

  /**
   * Log an error - most common use case
   * Replaces console.error throughout the app
   */
  error(message: string, error?: Error | unknown, context?: LogContext) {
    if (this.isDevelopment) {
      console.error(`[ERROR] ${message}`, error, context || '');
    }

    // Send to API in production (async, non-blocking)
    if (!this.isDevelopment && this.enableApiLogging) {
      this.sendToAPI('error', message, error, context);
    }
  }

  /**
   * Log a warning
   */
  warn(message: string, context?: LogContext) {
    if (this.isDevelopment) {
      console.warn(`[WARN] ${message}`, context || '');
    }

    if (!this.isDevelopment && this.enableApiLogging) {
      this.sendToAPI('warn', message, undefined, context);
    }
  }

  /**
   * Log informational message (only in development)
   */
  info(message: string, context?: LogContext) {
    if (this.isDevelopment) {
      console.log(`[INFO] ${message}`, context || '');
    }
  }

  /**
   * Log debug message (only in development)
   */
  debug(message: string, context?: LogContext) {
    if (this.isDevelopment) {
      console.debug(`[DEBUG] ${message}`, context || '');
    }
  }

  /**
   * Send error to your own API endpoint (zero-cost logging)
   * Runs async and never blocks the UI
   */
  private async sendToAPI(
    level: LogLevel,
    message: string,
    error?: Error | unknown,
    context?: LogContext
  ) {
    try {
      const payload = {
        level,
        message,
        timestamp: new Date().toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        url: typeof window !== 'undefined' ? window.location.href : 'unknown',
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : String(error),
        context,
      };

      // Send to your API - non-blocking, fire-and-forget
      fetch(`${this.apiUrl}/api/v1/internal/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // Use keepalive to ensure logs are sent even if page is closing
        keepalive: true,
      }).catch(() => {
        // Silently fail - we don't want logging errors to break the app
      });
    } catch (e) {
      // Silently fail - logging should never break the app
    }
  }
}

// Export singleton instance
export const logger = new Logger();

/**
 * Usage examples:
 *
 * // Replace console.error with:
 * logger.error('Failed to fetch policies', error);
 * logger.error('API call failed', error, { endpoint: '/api/v1/policies', userId: user.id });
 *
 * // Replace console.warn with:
 * logger.warn('Deprecated API usage', { feature: 'old-endpoint' });
 *
 * // Development-only logs:
 * logger.info('User logged in successfully');
 * logger.debug('Request payload:', { data });
 */
