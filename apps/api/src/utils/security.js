const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

const hashPassword = async (password) => {
    // OWASP 2024 recommendation: 12+ rounds for bcrypt
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
};

const verifyPassword = async (password, hash) => {
    return bcrypt.compare(password, hash);
};

const generateToken = (payload) => {
    const options = {
        expiresIn: process.env.JWT_EXPIRY || '1h',
    };

    if (env.JWT_ISSUER && env.JWT_AUDIENCE) {
        options.issuer = env.JWT_ISSUER;
        options.audience = env.JWT_AUDIENCE;
    }

    return jwt.sign(payload, env.JWT_SECRET, options);
};

const buildJwtClaims = ({ user_id, email, role, org_id, org_name }) => ({
    user_id,
    email,
    role,
    org_id,
    org_name,
});

const verifyToken = (token) => {
    const verifyOptions = {
        algorithms: ['HS256'], // ALWAYS enforce algorithm to prevent algorithm confusion attacks
    };

    if (env.JWT_ISSUER && env.JWT_AUDIENCE) {
        verifyOptions.issuer = env.JWT_ISSUER;
        verifyOptions.audience = env.JWT_AUDIENCE;
    }

    return jwt.verify(token, env.JWT_SECRET, verifyOptions);
};

const hashApiKey = (apiKey) => {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
};

const verifyApiKey = (apiKey, hashedKey) => {
    // Use timing-safe comparison to prevent timing attacks
    const computed = hashApiKey(apiKey);
    const computedBuf = Buffer.from(computed);
    const expectedBuf = Buffer.from(hashedKey);

    // Ensure same length before comparison
    if (computedBuf.length !== expectedBuf.length) {
        return false;
    }

    return crypto.timingSafeEqual(computedBuf, expectedBuf);
};

const generateApiKey = () => {
    const prefixSegment = crypto.randomBytes(4).toString('hex');
    const randomSegment = crypto.randomBytes(32).toString('hex');
    const key = `dd_${prefixSegment}_${randomSegment}`;
    const prefix = `dd_${prefixSegment}`;
    const hash = hashApiKey(key);

    return { key, prefix, hash };
};

// Constant-time string comparison (SEC-CFG-03). Returns false for non-strings / length mismatch
// while still performing a compare so the timing does not leak length.
const secureCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

module.exports = {
    hashPassword,
    verifyPassword,
    buildJwtClaims,
    generateToken,
    verifyToken,
    hashApiKey,
    verifyApiKey,
    generateApiKey,
    secureCompare,
};
