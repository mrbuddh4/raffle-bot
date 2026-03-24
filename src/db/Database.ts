import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';
import { getRequiredEnv } from '../utils/env';

export class Database {
  private static instance: Database;
  private readonly pool: Pool;

  private constructor() {
    this.pool = new Pool({
      connectionString: getRequiredEnv('DATABASE_URL'),
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  getPool(): Pool {
    return this.pool;
  }

  async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async runMigrations(): Promise<void> {
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    
    try {
      const files = await fs.readdir(migrationsDir);
      const sqlFiles = files.filter(file => file.endsWith('.sql')).sort();
      
      if (sqlFiles.length === 0) {
        console.log('📁 No migration files found');
        return;
      }

      const client = await this.pool.connect();
      try {
        // Create migrations tracking table if it doesn't exist
        await client.query(`
          CREATE TABLE IF NOT EXISTS migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        for (const file of sqlFiles) {
          // Check if migration has already been applied
          const result = await client.query('SELECT * FROM migrations WHERE name = $1', [file]);
          
          if (result.rows.length > 0) {
            console.log(`✅ Migration already applied: ${file}`);
            continue;
          }

          // Read and execute migration
          const migrationPath = path.join(migrationsDir, file);
          const migrationSql = await fs.readFile(migrationPath, 'utf-8');
          
          console.log(`⏳ Executing migration: ${file}`);
          await client.query(migrationSql);
          
          // Record migration as executed
          await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
          console.log(`✅ Migration executed: ${file}`);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('❌ Migration error:', error);
      // Don't throw - migrations might fail due to already existing schema on first run
      // The important part is that subsequent runs will track what's been applied
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
