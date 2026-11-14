'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function masterKey() {
  const value = process.env.ENCRYPTION_MASTER_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for context source credentials');
  }
  return Buffer.from(value, 'hex');
}

function encryptCredential(credential) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function decryptCredential(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith(`${VERSION}:`)) {
    throw new Error('Expected encrypted credential payload');
  }

  const parts = encoded.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted credential payload');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      masterKey(),
      Buffer.from(parts[1], 'base64url')
    );
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (err) {
    if (err.message === 'ENCRYPTION_MASTER_KEY is required for context source credentials') {
      throw err;
    }
    throw new Error('Unable to decrypt context source credential');
  }
}

module.exports = {
  encryptCredential,
  decryptCredential,
};
