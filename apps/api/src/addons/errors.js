'use strict';

/** An add-on refusal with an HTTP status and a stable machine code. */
class AddonError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AddonError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

const isAddonError = (err) => err instanceof AddonError;

module.exports = { AddonError, isAddonError };
