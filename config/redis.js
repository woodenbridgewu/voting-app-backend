const redis = require('redis');

let client;

const connectRedis = async () => {
    try {
        console.log('🔄 Connecting to Redis...');

        client = redis.createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379'
        });

        client.on('error', (err) => {
            console.error('Redis error:', err);
        });

        client.on('connect', () => {
            console.log('✅ Connected to Redis');
        });

        await client.connect();
    } catch (error) {
        console.error('❌ Redis connection failed:', error);
        throw error;
    }
};

// Check if user has voted for a poll today
const hasVotedToday = async (userId, pollId) => {
    try {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const key = `vote:${userId}:${pollId}:${today}`;
        const result = await client.get(key);
        return result === 'voted';
    } catch (error) {
        console.error('Redis hasVotedToday error:', error);
        return false; // Fail open - allow vote if Redis is down
    }
};

// Mark user as voted for a poll today
const markAsVoted = async (userId, pollId) => {
    try {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const key = `vote:${userId}:${pollId}:${today}`;
        // Set expiration to 25 hours to account for timezone differences
        await client.setEx(key, 25 * 60 * 60, 'voted');
    } catch (error) {
        console.error('Redis markAsVoted error:', error);
        // Don't throw - logging is sufficient
    }
};

// Cache poll results
const cachePollResults = async (pollId, results, ttl = 300) => { // 5 minutes default
    try {
        const key = `poll_results:${pollId}`;
        await client.setEx(key, ttl, JSON.stringify(results));
    } catch (error) {
        console.error('Redis cachePollResults error:', error);
    }
};

// Get cached poll results
const getCachedPollResults = async (pollId) => {
    try {
        const key = `poll_results:${pollId}`;
        const result = await client.get(key);
        return result ? JSON.parse(result) : null;
    } catch (error) {
        console.error('Redis getCachedPollResults error:', error);
        return null;
    }
};

// Store JWT token (for logout functionality)
const storeToken = async (token, userId, expirationTime) => {
    try {
        if (!client || !client.isReady) {
            console.warn('Redis client not ready, skipping token storage');
            return;
        }
        const key = `token:${token}`;
        await client.setEx(key, expirationTime, userId);
    } catch (error) {
        console.error('Redis storeToken error:', error);
    }
};

// Check if token is blacklisted
const isTokenBlacklisted = async (token) => {
    try {
        if (!client || !client.isReady) {
            console.warn('Redis client not ready, skipping blacklist check');
            return false;
        }
        const key = `blacklist:${token}`;
        const result = await client.get(key);
        return result === 'blacklisted';
    } catch (error) {
        console.error('Redis isTokenBlacklisted error:', error);
        return false;
    }
};

// Blacklist token (for logout)
const blacklistToken = async (token, expirationTime) => {
    try {
        if (!client || !client.isReady) {
            console.warn('Redis client not ready, skipping token blacklist');
            return;
        }
        const key = `blacklist:${blacklistToken}`;
        await client.setEx(key, expirationTime, 'blacklisted');
    } catch (error) {
        console.error('Redis blacklistToken error:', error);
    }
};

module.exports = {
    connectRedis,
    hasVotedToday,
    markAsVoted,
    cachePollResults,
    getCachedPollResults,
    storeToken,
    isTokenBlacklisted,
    blacklistToken,
    getClient: () => client
};