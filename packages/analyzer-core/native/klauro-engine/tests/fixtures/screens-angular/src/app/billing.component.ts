import { Component } from '@angular/core';

@Component({ selector: 'app-billing', template: '<p>Billing</p>' })
export class BillingComponent {
  async pay() {
    await fetch('/api/billing/pay', { method: 'POST' });
  }
}
