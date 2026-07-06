export interface Promotion {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'promotion_active' | 'promotion_inactive';
}
