export interface Category {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'category_active' | 'category_inactive';
}
