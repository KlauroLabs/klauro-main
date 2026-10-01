import { createRouter, createWebHistory } from 'vue-router';
import HomeView from './views/HomeView';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/reports/:id', name: 'report', component: () => import('./views/ReportView') },
  ],
});
