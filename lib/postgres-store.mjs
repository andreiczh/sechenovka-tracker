import pg from 'pg';

export function createPostgresStore(databaseUrl) {
  const parsed = new URL(databaseUrl);
  // Let pg use its normal verified TLS configuration without URL overrides.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) parsed.searchParams.delete(key);
  const pool = new pg.Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true }, max: 4, connectionTimeoutMillis: 12000, idleTimeoutMillis: 30000, statement_timeout: 12000, application_name: 'sechenovka-synthetic-demo' });
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error', at: new Date().toISOString() })));
  const ready = pool.query('CREATE TABLE IF NOT EXISTS demo_sessions (id TEXT PRIMARY KEY, state JSONB NOT NULL); CREATE TABLE IF NOT EXISTS demo_clinician_workspaces (owner_id TEXT PRIMARY KEY, state JSONB NOT NULL); CREATE TABLE IF NOT EXISTS demo_telegram_chats (session_id TEXT PRIMARY KEY, state JSONB NOT NULL)').then(() => undefined);
  ready.catch(() => {});
  function operations(client) {
    return {
      async get(id) { return (await client.query('SELECT state FROM demo_sessions WHERE id = $1', [id])).rows[0]?.state || null; },
      async save(id, state) { await client.query('INSERT INTO demo_sessions (id, state) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET state=excluded.state', [id, state]); },
      async getWorkspace(id) { return (await client.query('SELECT state FROM demo_clinician_workspaces WHERE owner_id = $1', [id])).rows[0]?.state || null; },
      async saveWorkspace(id, state) { await client.query('INSERT INTO demo_clinician_workspaces (owner_id, state) VALUES ($1, $2) ON CONFLICT(owner_id) DO UPDATE SET state=excluded.state', [id, state]); },
      async getTelegram(id) { return (await client.query('SELECT state FROM demo_telegram_chats WHERE session_id = $1', [id])).rows[0]?.state || null; },
      async saveTelegram(id, state) { await client.query('INSERT INTO demo_telegram_chats (session_id, state) VALUES ($1, $2) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state', [id, state]); },
      async allTelegram() { return (await client.query('SELECT session_id AS id, state FROM demo_telegram_chats')).rows; },
      async all() { return (await client.query('SELECT id, state FROM demo_sessions')).rows; },
    };
  }
  return {
    ready,
    async all() { await ready; return operations(pool).all(); },
    async allTelegram() { await ready; return operations(pool).allTelegram(); },
    async withSession(id, callback) {
      await ready;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The lock covers both patient and doctor records, including first creation.
        // Overlapping deploys use the same DB lock, not a process-local mutex.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
        const result = await callback(operations(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
