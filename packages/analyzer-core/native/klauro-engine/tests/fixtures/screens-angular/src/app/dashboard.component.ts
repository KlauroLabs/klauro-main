import { Component } from '@angular/core';

@Component({ selector: 'app-dashboard', template: '<button (click)="refresh()">Refresh</button>' })
export class DashboardComponent {
  async refresh() {
    await fetch('/api/dashboard/refresh', { method: 'POST' });
  }
}
