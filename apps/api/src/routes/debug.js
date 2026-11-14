const express = require('express');
const router = express.Router();

// Store last auth errors in memory for debugging
const authErrors = [];
const MAX_ERRORS = 10;

function logAuthError(error) {
    authErrors.unshift({
        timestamp: new Date().toISOString(),
        error: {
            message: error.message,
            stack: error.stack,
            code: error.code
        }
    });
    if (authErrors.length > MAX_ERRORS) {
        authErrors.pop();
    }
}

// Debug endpoint to view recent auth errors — dev only
router.get('/auth-errors', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'not_found' });
    }
    res.json({
        count: authErrors.length,
        errors: authErrors
    });
});

module.exports = { router, logAuthError };
