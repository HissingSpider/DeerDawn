let migrationPromise = null;

async function ensureRuntimeSchema() {
  if (!migrationPromise) {
    const { runAutoMigration } = require('../../src/config/autoMigrate');
    migrationPromise = runAutoMigration();
  }
  return migrationPromise;
}

module.exports = {
  ensureRuntimeSchema,
};
