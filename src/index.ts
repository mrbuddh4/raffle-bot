import dotenv from 'dotenv';
import { Database } from './db/Database';
import { RaffleBot } from './bot/RaffleBot';

dotenv.config({ override: true });

async function main(): Promise<void> {
  const db = Database.getInstance();
  await db.initialize();
  await db.runMigrations();

  const bot = new RaffleBot(db.getPool());
  await bot.start();

  process.on('SIGINT', async () => {
    await bot.stop();
    await db.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await bot.stop();
    await db.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
