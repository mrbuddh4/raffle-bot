import { Pool } from 'pg';

export class GroupChatService {
  constructor(private readonly pool: Pool) {}

  async upsertGroupChat(chatId: number, chatType: 'group' | 'supergroup', chatTitle?: string | null): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO bot_group_chats (chat_id, chat_type, chat_title, is_active)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (chat_id)
      DO UPDATE SET
        chat_type = EXCLUDED.chat_type,
        chat_title = EXCLUDED.chat_title,
        is_active = TRUE,
        updated_at = NOW()
      `,
      [chatId, chatType, chatTitle ?? null]
    );
  }

  async listActiveGroupChatIds(): Promise<number[]> {
    const result = await this.pool.query(
      `
      SELECT chat_id
      FROM bot_group_chats
      WHERE is_active = TRUE
      `
    );

    return result.rows.map((row) => Number(row.chat_id));
  }

  async deactivateGroupChat(chatId: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE bot_group_chats
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE chat_id = $1
      `,
      [chatId]
    );
  }
}
