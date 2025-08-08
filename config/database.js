const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Database schema initialization
const initDatabase = async () => {
  try {
    console.log('🔄 Initializing database...');

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create polls table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS polls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        creator_id UUID REFERENCES users(id) ON DELETE CASCADE,
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create poll_options table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS poll_options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        poll_id UUID REFERENCES polls(id) ON DELETE CASCADE,
        text VARCHAR(255) NOT NULL,
        image_url TEXT,
        vote_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create vote_records table (修復：移除 DATE 函數)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vote_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        poll_id UUID REFERENCES polls(id) ON DELETE CASCADE,
        option_id UUID REFERENCES poll_options(id) ON DELETE CASCADE,
        voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, poll_id)
      )
    `);

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_polls_creator_id ON polls(creator_id);
      CREATE INDEX IF NOT EXISTS idx_poll_options_poll_id ON poll_options(poll_id);
      CREATE INDEX IF NOT EXISTS idx_vote_records_user_poll ON vote_records(user_id, poll_id);
      CREATE INDEX IF NOT EXISTS idx_vote_records_poll_id ON vote_records(poll_id);
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
};

// Helper function to update vote counts
const updateVoteCount = async (optionId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT COUNT(*) as count FROM vote_records WHERE option_id = $1',
      [optionId]
    );

    await client.query(
      'UPDATE poll_options SET vote_count = $1 WHERE id = $2',
      [parseInt(result.rows[0].count), optionId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  initDatabase,
  updateVoteCount
};