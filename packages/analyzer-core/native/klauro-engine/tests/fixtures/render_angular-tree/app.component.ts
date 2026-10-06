import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <main>
      <app-user-card [name]="'Ada'" [age]="36"></app-user-card>
    </main>
  `,
})
export class AppComponent {}
