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
    const filePath = path.resolve(process.cwd(), 'migrations', '001_init.sql');
    const sql = await fs.readFile(filePath, 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
