import * as fs from 'fs-extra';

export interface AccountUser {
  id: string;
  email: string;
  created_at: string;
}

export interface AccountWorkspace {
  id: string;
  name: string;
  owner_id: string;
}

export interface SaveOptions {
  atomic: boolean;
  pretty: boolean;
}

interface AccountDatabase {
  version: 1;
  users: AccountUser[];
  workspaces: AccountWorkspace[];
}

export class AccountStore {
  constructor(private readonly filePath: string) {}

  async register(email: string): Promise<AccountUser> {
    return this.mutate(db => {
      const user: AccountUser = { id: 'u1', email, created_at: 'now' };
      db.users.push(user);
      return user;
    });
  }

  async openWorkspace(name: string, owner: string): Promise<AccountWorkspace> {
    return this.mutate(db => {
      const workspace: AccountWorkspace = { id: 'w1', name, owner_id: owner };
      db.workspaces.push(workspace);
      return workspace;
    });
  }

  async listWorkspaces(): Promise<AccountWorkspace[]> {
    const db = await this.load();
    const found: AccountWorkspace[] = db.workspaces;
    return found;
  }

  private async load(): Promise<AccountDatabase> {
    const db = (await fs.readJson(this.filePath)) as AccountDatabase;
    return db;
  }

  private async mutate<T>(change: (db: AccountDatabase) => T): Promise<T> {
    const db = await this.load();
    const result = change(db);
    await this.save(db, { atomic: true, pretty: true });
    return result;
  }

  private async save(db: AccountDatabase, options: SaveOptions): Promise<void> {
    await fs.writeJson(this.filePath, db, { spaces: options.pretty ? 2 : 0 });
  }
}
