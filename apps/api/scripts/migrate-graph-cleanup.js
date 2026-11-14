const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';

async function run() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: getDbSslConfig(),
  });

  await client.connect();
  console.log('[GRAPH-CLEANUP] Connected');

  // Delete evidence for concept nodes (FK order)
  const ev = await client.query(
    `DELETE FROM context_graph_evidence
     WHERE node_id IN (SELECT node_id FROM context_graph_nodes WHERE node_type = 'concept')`
  );
  console.log(`[GRAPH-CLEANUP] Deleted ${ev.rowCount} evidence rows`);

  // Delete edges referencing concept nodes
  const ed = await client.query(
    `DELETE FROM context_graph_edges
     WHERE from_node_id IN (SELECT node_id FROM context_graph_nodes WHERE node_type = 'concept')
        OR to_node_id   IN (SELECT node_id FROM context_graph_nodes WHERE node_type = 'concept')`
  );
  console.log(`[GRAPH-CLEANUP] Deleted ${ed.rowCount} edges`);

  // Delete the concept nodes
  const nd = await client.query('DELETE FROM context_graph_nodes WHERE node_type = \'concept\'');
  console.log(`[GRAPH-CLEANUP] Deleted ${nd.rowCount} concept nodes`);

  await client.end();
  console.log('[GRAPH-CLEANUP] Done');
  process.exit(0);
}

run().catch((err) => {
  console.error('[GRAPH-CLEANUP] Failed:', err.message);
  process.exit(1);
});
