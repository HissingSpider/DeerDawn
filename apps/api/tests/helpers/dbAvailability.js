async function ensureDatabaseAvailable(t, db, label = 'database-backed test suite') {
  let client;
  try {
    client = await db.pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    t.diagnostic(`Skipping ${label}: database unavailable (${message})`);
    t.skip(`Database unavailable for ${label}`);
    return false;
  } finally {
    client?.release?.();
  }
}

module.exports = {
  ensureDatabaseAvailable,
};
