import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-user-card',
  template: `<div class="card">{{ name }} ({{ age }})</div>`,
})
export class UserCardComponent {
  @Input() name!: string;
  @Input() age!: number;
}
