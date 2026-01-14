import { Migration } from '@mikro-orm/migrations';

export class Migration20251009000000AddNameToUsers extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE users ADD COLUMN name VARCHAR(200) NOT NULL DEFAULT \'\';');
  }

  async down(): Promise<void> {
    this.addSql('ALTER TABLE users DROP COLUMN IF EXISTS name;');
  }
}
