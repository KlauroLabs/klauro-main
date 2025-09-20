/**
 * Safe localStorage utility to handle quota exceeded errors
 */

export interface StorageResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Safely store data in localStorage with size limits and error handling
 */
export function safeSetItem<T>(key: string, data: T, maxSizeBytes: number = 1000000): StorageResult<T> {
  try {
    const serialized = JSON.stringify(data);

    // Check size before storing
    if (serialized.length > maxSizeBytes) {
      return {
        success: false,
        error: `Data too large (${serialized.length} bytes, max ${maxSizeBytes})`
      };
    }

    localStorage.setItem(key, serialized);
    return { success: true };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // If it's a quota exceeded error, try to free up space
    if (errorMessage.includes('QuotaExceededError') || errorMessage.includes('quota')) {
      try {
        // Clear old analysis data
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('analysis_')) {
            keysToRemove.push(key);
          }
        }

        keysToRemove.forEach(key => {
          try {
            localStorage.removeItem(key);
          } catch {}
        });

        // Try storing again
        localStorage.setItem(key, JSON.stringify(data));
        return { success: true };

      } catch (retryError) {
        return {
          success: false,
          error: `Storage quota exceeded and cleanup failed: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`
        };
      }
    }

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Safely retrieve data from localStorage with error handling
 */
export function safeGetItem<T>(key: string): StorageResult<T> {
  try {
    const item = localStorage.getItem(key);
    if (!item) {
      return { success: false, error: 'Item not found' };
    }

    const parsed = JSON.parse(item) as T;
    return { success: true, data: parsed };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Try to clean up corrupted data
    try {
      localStorage.removeItem(key);
    } catch {}

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Remove item from localStorage safely
 */
export function safeRemoveItem(key: string): StorageResult<void> {
  try {
    localStorage.removeItem(key);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get localStorage usage information
 */
export function getStorageInfo(): {
  used: number;
  available: number;
  itemCount: number;
} {
  let used = 0;
  let itemCount = 0;

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const value = localStorage.getItem(key);
        if (value) {
          used += key.length + value.length;
          itemCount++;
        }
      }
    }
  } catch {}

  // Typical localStorage limit is 5-10MB, we'll estimate 5MB
  const typical = 5 * 1024 * 1024;

  return {
    used,
    available: Math.max(0, typical - used),
    itemCount
  };
}