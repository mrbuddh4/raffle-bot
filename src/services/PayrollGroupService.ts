import { Pool } from 'pg';
import { WalletChain } from '../utils/validators';

export type PayrollMode = 'native' | 'token';

export interface PayrollGroup {
  id: number;
  adminTelegramUserId: number;
  name: string;
  chain: WalletChain;
  mode: PayrollMode;
  tokenAddress: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayrollGroupItem {
  id: number;
  payrollGroupId: number;
  walletAddress: string;
  amount: number;
  createdAt: Date;
}

export class PayrollGroupService {
  constructor(private readonly pool: Pool) {}

  async upsertGroupWithItems(input: {
    adminTelegramUserId: number;
    name: string;
    chain: WalletChain;
    mode: PayrollMode;
    tokenAddress?: string;
    items: Array<{ walletAddress: string; amount: number }>;
  }): Promise<PayrollGroup> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const groupResult = await client.query(
        `
        INSERT INTO payroll_groups (admin_telegram_user_id, name, chain, mode, token_address)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (admin_telegram_user_id, name)
        DO UPDATE SET
          chain = EXCLUDED.chain,
          mode = EXCLUDED.mode,
          token_address = EXCLUDED.token_address,
          updated_at = NOW()
        RETURNING id, admin_telegram_user_id, name, chain, mode, token_address, created_at, updated_at
        `,
        [input.adminTelegramUserId, input.name.trim(), input.chain, input.mode, input.tokenAddress ?? null]
      );

      const group = this.mapGroup(groupResult.rows[0]);

      await client.query(`DELETE FROM payroll_group_items WHERE payroll_group_id = $1`, [group.id]);

      for (const item of input.items) {
        await client.query(
          `
          INSERT INTO payroll_group_items (payroll_group_id, wallet_address, amount)
          VALUES ($1, $2, $3)
          `,
          [group.id, item.walletAddress, item.amount]
        );
      }

      await client.query('COMMIT');
      return group;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listGroups(adminTelegramUserId: number): Promise<PayrollGroup[]> {
    const result = await this.pool.query(
      `
      SELECT id, admin_telegram_user_id, name, chain, mode, token_address, created_at, updated_at
      FROM payroll_groups
      WHERE admin_telegram_user_id = $1
      ORDER BY updated_at DESC, id DESC
      `,
      [adminTelegramUserId]
    );

    return result.rows.map((row) => this.mapGroup(row));
  }

  async getGroupById(adminTelegramUserId: number, groupId: number): Promise<PayrollGroup | null> {
    const result = await this.pool.query(
      `
      SELECT id, admin_telegram_user_id, name, chain, mode, token_address, created_at, updated_at
      FROM payroll_groups
      WHERE admin_telegram_user_id = $1
        AND id = $2
      LIMIT 1
      `,
      [adminTelegramUserId, groupId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapGroup(result.rows[0]);
  }

  async getGroupItems(groupId: number): Promise<PayrollGroupItem[]> {
    const result = await this.pool.query(
      `
      SELECT id, payroll_group_id, wallet_address, amount, created_at
      FROM payroll_group_items
      WHERE payroll_group_id = $1
      ORDER BY id ASC
      `,
      [groupId]
    );

    return result.rows.map((row) => this.mapGroupItem(row));
  }

  async deleteGroup(adminTelegramUserId: number, groupId: number): Promise<boolean> {
    const result = await this.pool.query(
      `
      DELETE FROM payroll_groups
      WHERE admin_telegram_user_id = $1
        AND id = $2
      `,
      [adminTelegramUserId, groupId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  private mapGroup(row: any): PayrollGroup {
    return {
      id: Number(row.id),
      adminTelegramUserId: Number(row.admin_telegram_user_id),
      name: row.name,
      chain: row.chain,
      mode: row.mode,
      tokenAddress: row.token_address ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapGroupItem(row: any): PayrollGroupItem {
    return {
      id: Number(row.id),
      payrollGroupId: Number(row.payroll_group_id),
      walletAddress: row.wallet_address,
      amount: Number(row.amount),
      createdAt: new Date(row.created_at),
    };
  }
}
