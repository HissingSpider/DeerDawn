/**
 * Runs the boot-time schema migration (src/config/autoMigrate.js) once,
 * outside a server.
 *
 * Production always boots, and so always migrates, before it serves anything.
 * The test database used to get that schema only as a side effect: some
 * earlier file in the single serial run called runAutoMigration, and every
 * later file inherited it. Split across CI shards, a file can be first on a
 * fresh database, and hosted-connections-disconnect.test.js failed exactly
 * that way (oauth_clients missing, every connect a 503). bootstrap-test-db.sh
 * runs this so no file depends on what ran before it.
 */
const { runAutoMigration } = require('../src/config/autoMigrate');
const db = require('../src/config/db');

runAutoMigration()
  .then(() => db.pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-boot-schema] failed:', err);
    process.exit(1);
  });
