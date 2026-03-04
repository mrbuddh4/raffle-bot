import { Pool } from 'pg';
import { WalletChain } from '../utils/validators';

export interface RegisteredUser {
  id: number;
  telegramUserId: number;
  telegramUsername: string | null;
  displayUsername: string;
  walletChain: WalletChain;
  walletAddress: string;
  evmWalletAddress: string | null;
  solanaWalletAddress: string | null;
}

export class UserService {
  constructor(private readonly pool: Pool) {}

  async upsertUser(input: {
    telegramUserId: number;
    telegramUsername: string | null;
    displayUsername: string;
    walletChain: WalletChain;
    walletAddress: string;
  }): Promise<RegisteredUser> {
    const result = await this.pool.query(
      `
      INSERT INTO users (
        telegram_user_id,
        telegram_username,
        display_username,
        wallet_chain,
        wallet_address,
        evm_wallet_address,
        solana_wallet_address
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        CASE WHEN $4 = 'evm' THEN $5 ELSE NULL END,
        CASE WHEN $4 = 'solana' THEN $5 ELSE NULL END
      )
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET
        telegram_username = EXCLUDED.telegram_username,
        display_username = EXCLUDED.display_username,
        wallet_chain = EXCLUDED.wallet_chain,
        wallet_address = EXCLUDED.wallet_address,
        evm_wallet_address = CASE
          WHEN EXCLUDED.wallet_chain = 'evm' THEN EXCLUDED.wallet_address
          ELSE users.evm_wallet_address
        END,
        solana_wallet_address = CASE
          WHEN EXCLUDED.wallet_chain = 'solana' THEN EXCLUDED.wallet_address
          ELSE users.solana_wallet_address
        END,
        updated_at = NOW()
      RETURNING id, telegram_user_id, telegram_username, display_username, wallet_chain, wallet_address, evm_wallet_address, solana_wallet_address
      `,
      [input.telegramUserId, input.telegramUsername, input.displayUsername, input.walletChain, input.walletAddress]
    );

    return this.mapUser(result.rows[0]);
  }

  async getByTelegramUserId(telegramUserId: number): Promise<RegisteredUser | null> {
    const result = await this.pool.query(
      `
      SELECT id, telegram_user_id, telegram_username, display_username, wallet_chain, wallet_address, evm_wallet_address, solana_wallet_address
      FROM users
      WHERE telegram_user_id = $1
      `,
      [telegramUserId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapUser(result.rows[0]);
  }

  async upsertManyFromCsv(rows: Array<{ displayUsername: string; walletChain: WalletChain; walletAddress: string; telegramUsername?: string | null }>): Promise<number> {
    let count = 0;

    for (const row of rows) {
      const syntheticTelegramId = Date.now() + Math.floor(Math.random() * 1000000) + count;
      await this.pool.query(
        `
        INSERT INTO users (
          telegram_user_id,
          telegram_username,
          display_username,
          wallet_chain,
          wallet_address,
          evm_wallet_address,
          solana_wallet_address
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          CASE WHEN $4 = 'evm' THEN $5 ELSE NULL END,
          CASE WHEN $4 = 'solana' THEN $5 ELSE NULL END
        )
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          telegram_username = EXCLUDED.telegram_username,
          display_username = EXCLUDED.display_username,
          wallet_chain = EXCLUDED.wallet_chain,
          wallet_address = EXCLUDED.wallet_address,
          evm_wallet_address = CASE
            WHEN EXCLUDED.wallet_chain = 'evm' THEN EXCLUDED.wallet_address
            ELSE users.evm_wallet_address
          END,
          solana_wallet_address = CASE
            WHEN EXCLUDED.wallet_chain = 'solana' THEN EXCLUDED.wallet_address
            ELSE users.solana_wallet_address
          END,
          updated_at = NOW()
        `,
        [syntheticTelegramId, row.telegramUsername ?? null, row.displayUsername, row.walletChain, row.walletAddress]
      );
      count += 1;
    }

    return count;
  }

  private mapUser(row: any): RegisteredUser {
    return {
      id: Number(row.id),
      telegramUserId: Number(row.telegram_user_id),
      telegramUsername: row.telegram_username,
      displayUsername: row.display_username,
      walletChain: row.wallet_chain,
      walletAddress: row.wallet_address,
      evmWalletAddress: row.evm_wallet_address,
      solanaWalletAddress: row.solana_wallet_address,
    };
  }
}
