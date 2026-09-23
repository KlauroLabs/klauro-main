import { HttpClient } from '@angular/common/http';

export class Accounts {
  constructor(private readonly http: HttpClient) {}

  register(account: { name: string }) {
    return this.http.post('/accounts', { account });
  }
}
