import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { UserPage } from './pages/UserPage';
import { OrderPage } from './pages/OrderPage';
import { ProductPage } from './pages/ProductPage';
import { InvoicePage } from './pages/InvoicePage';
import { PaymentPage } from './pages/PaymentPage';
import { CustomerPage } from './pages/CustomerPage';
import { ShipmentPage } from './pages/ShipmentPage';
import { InventoryPage } from './pages/InventoryPage';
import { ReviewPage } from './pages/ReviewPage';
import { CategoryPage } from './pages/CategoryPage';
import { CartPage } from './pages/CartPage';
import { CouponPage } from './pages/CouponPage';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { NotificationPage } from './pages/NotificationPage';

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/users" element={<UserPage />} />
        <Route path="/orders" element={<OrderPage />} />
        <Route path="/products" element={<ProductPage />} />
        <Route path="/invoices" element={<InvoicePage />} />
        <Route path="/payments" element={<PaymentPage />} />
        <Route path="/customers" element={<CustomerPage />} />
        <Route path="/shipments" element={<ShipmentPage />} />
        <Route path="/inventorys" element={<InventoryPage />} />
        <Route path="/reviews" element={<ReviewPage />} />
        <Route path="/categorys" element={<CategoryPage />} />
        <Route path="/carts" element={<CartPage />} />
        <Route path="/coupons" element={<CouponPage />} />
        <Route path="/subscriptions" element={<SubscriptionPage />} />
        <Route path="/notifications" element={<NotificationPage />} />
      </Routes>
    </BrowserRouter>
  );
}
