/**
 * Default list of sensitive field names to redact.
 * Used when no organization-specific keys are configured.
 * Covers common PII, credentials, and sensitive data patterns.
 */
const DEFAULT_SENSITIVE_KEYS = [
    // Credentials
    'password', 'passwd', 'pwd', 'pass',
    'secret', 'secret_key', 'secretkey',
    'api_key', 'apikey', 'api-key',
    'access_token', 'accesstoken', 'access-token',
    'refresh_token', 'refreshtoken', 'refresh-token',
    'token', 'auth_token', 'authtoken',
    'bearer', 'authorization', 'auth',
    'private_key', 'privatekey', 'private-key',
    'session', 'session_id', 'sessionid',
    'cookie', 'cookies',

    // Financial
    'credit_card', 'creditcard', 'card_number', 'cardnumber',
    'cc_number', 'ccnumber', 'cc_num',
    'cvv', 'cvc', 'security_code', 'securitycode',
    'card_exp', 'expiry', 'expiration',
    'account_number', 'accountnumber', 'acct_num',
    'routing_number', 'routingnumber', 'aba', 'iban', 'swift',
    'bank_account', 'bankaccount',

    // PII
    'ssn', 'social_security', 'socialsecurity', 'social_security_number',
    'tax_id', 'taxid', 'ein', 'tin',
    'drivers_license', 'driverslicense', 'driver_license', 'dl_number',
    'passport', 'passport_number', 'passportnumber',
    'dob', 'date_of_birth', 'dateofbirth', 'birthdate', 'birth_date',

    // Contact (when sensitive)
    'phone', 'phone_number', 'phonenumber', 'mobile', 'cell',

    // Medical
    'medical_record', 'medicalrecord', 'mrn', 'health_id',

    // Encryption
    'encryption_key', 'encryptionkey', 'cipher_key', 'cipherkey',
    'signing_key', 'signingkey', 'hmac_key', 'hmackey'
];

/**
 * Redact sensitive fields from an object based on the organization's strategy.
 *
 * @param {Object} obj - The object to redact (e.g., payload, findings)
 * @param {Array<string>} keys - Whitelist if mode is 'strict', Blacklist if 'permissive'
 * @param {string} mode - 'strict' (default) or 'permissive'
 * @returns {Object} - The redacted object
 */
function redact(obj, keys = [], mode = 'strict') {
    if (!obj || typeof obj !== 'object') return obj;
  
    if (Array.isArray(obj)) {
        return obj.map(item => redact(item, keys, mode));
    }

    const newObj = {};
    const entries = Object.entries(obj);

    for (const [key, value] of entries) {
        const isMatched = keys.some(k => key.toLowerCase() === k.toLowerCase());
    
        if (mode === 'strict') {
            // In Strict Mode, ONLY the whitelisted keys are kept as-is. 
            // Everything else is redacted or recursively checked.
            if (isMatched) {
                newObj[key] = value;
            } else if (value && typeof value === 'object') {
                newObj[key] = redact(value, keys, mode);
            } else {
                newObj[key] = '[REDACTED]';
            }
        } else {
            // In Permissive Mode (Blacklist), specific keys are redacted.
            if (isMatched) {
                newObj[key] = '[REDACTED]';
            } else if (value && typeof value === 'object') {
                newObj[key] = redact(value, keys, mode);
            } else {
                newObj[key] = value;
            }
        }
    }
  
    return newObj;
}

module.exports = { redact, DEFAULT_SENSITIVE_KEYS };
