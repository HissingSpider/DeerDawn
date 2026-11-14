const db = require('../config/db');
const { redis } = require('../config/redis');
const { LRUCache } = require('lru-cache');

class OrgService {
    constructor() {
        this.TTL = 60 * 5; // 5 minutes
        this.cache = new LRUCache({
            max: 1000,
            ttl: this.TTL * 1000,
        });
    }

    async getOrgById(orgId) {
        if (!orgId) return null;

        const memoryCacheKey = `org:${orgId}`;
        const redisCacheKey = `org-redis:${orgId}`;

        // 1. Check in-memory cache
        const memoryCached = this.cache.get(memoryCacheKey);
        if (memoryCached) {
            return memoryCached;
        }

        // 2. Check Redis cache
        try {
            const redisCached = await redis.get(redisCacheKey);
            if (redisCached) {
                const org = JSON.parse(redisCached);
                this.cache.set(memoryCacheKey, org);
                return org;
            }
        } catch (e) {
            console.error('Redis Cache Error (OrgService):', e);
        }

        // 3. Fetch from database
        const { rows } = await db.query('SELECT * FROM organizations WHERE org_id = $1', [orgId], orgId);
        if (rows.length === 0) {
            return null;
        }
        const org = rows[0];

        // 4. Populate caches
        this.cache.set(memoryCacheKey, org);
        try {
            await redis.setex(redisCacheKey, this.TTL, JSON.stringify(org));
        } catch (e) {
            console.error('Redis Save Error (OrgService):', e);
        }

        return org;
    }

    async invalidate(orgId) {
        this.cache.delete(`org:${orgId}`);
        await redis.del(`org-redis:${orgId}`);
    }
}

module.exports = new OrgService();
