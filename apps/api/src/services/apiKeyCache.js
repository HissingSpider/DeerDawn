const { LRUCache } = require('lru-cache');
const { getSubscriber, getPublisher } = require('../config/redis');
const env = require('../config/env');

const cache = new LRUCache({
    max: 10000,              // Max 10k API keys in memory (~5MB)
    ttl: 1000 * 60 * 5,      // 5 minute TTL
    updateAgeOnGet: true,     // Refresh TTL on access
    updateAgeOnHas: false
});

let subscriber = null;
let publisher = null;
const INVALIDATION_CHANNEL = 'apikey:invalidate';

function initializeRedis() {
    if (!subscriber && env.REDIS_URL) {
        try {
            subscriber = getSubscriber();
            publisher = getPublisher();

            subscriber.subscribe(INVALIDATION_CHANNEL, (err) => {
                if (err) {
                    console.error('[API KEY CACHE] Subscribe error:', err);
                } else {
                    console.log('[API KEY CACHE] Subscribed to invalidation channel');
                }
            });

            subscriber.on('message', (channel, keyHash) => {
                if (channel === INVALIDATION_CHANNEL) {
                    cache.delete(keyHash);
                    console.log(`[API KEY CACHE] Invalidated: ${keyHash.substring(0, 16)}...`);
                }
            });

            subscriber.on('error', (err) => {
                console.error('[API KEY CACHE] Redis subscriber error:', err.message);
            });

            publisher.on('error', (err) => {
                console.error('[API KEY CACHE] Redis publisher error:', err.message);
            });
        } catch (err) {
            console.error('[API KEY CACHE] Failed to initialize Redis:', err);
        }
    }
}

// Initialize Redis pub/sub on module load
if (env.ENABLE_API_KEY_CACHE !== false) {
    initializeRedis();
}

function getApiKey(keyHash) {
    if (env.ENABLE_API_KEY_CACHE === false) {
        return null; // Feature flag disabled
    }
    return cache.get(keyHash);
}

function setApiKey(keyHash, keyData) {
    if (env.ENABLE_API_KEY_CACHE === false) {
        return; // Feature flag disabled
    }
    cache.set(keyHash, keyData);
}

async function invalidateApiKey(keyHash) {
    // Remove from local cache
    cache.delete(keyHash);

    // Publish to all instances
    if (publisher) {
        try {
            await publisher.publish(INVALIDATION_CHANNEL, keyHash);
            console.log(`[API KEY CACHE] Published invalidation: ${keyHash.substring(0, 16)}...`);
        } catch (err) {
            console.error('[API KEY CACHE] Failed to publish invalidation:', err);
        }
    }
}

function getCacheStats() {
    return {
        size: cache.size,
        max: cache.max,
        calculatedSize: cache.calculatedSize
    };
}

module.exports = {
    getApiKey,
    setApiKey,
    invalidateApiKey,
    getCacheStats
};
