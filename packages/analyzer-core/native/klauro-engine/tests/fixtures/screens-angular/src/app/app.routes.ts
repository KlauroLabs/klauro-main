import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard.component';

export const routes: Routes = [
  { path: 'dashboard', component: DashboardComponent },
  { path: 'billing', loadComponent: () => import('./billing.component').then((m) => m.BillingComponent) },
];
