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
import { AddressPage } from './pages/AddressPage';
import { RefundPage } from './pages/RefundPage';
import { TicketPage } from './pages/TicketPage';
import { SessionPage } from './pages/SessionPage';
import { ReportPage } from './pages/ReportPage';
import { VendorPage } from './pages/VendorPage';
import { WarehousePage } from './pages/WarehousePage';
import { EmployeePage } from './pages/EmployeePage';
import { DepartmentPage } from './pages/DepartmentPage';
import { ProjectPage } from './pages/ProjectPage';
import { TaskPage } from './pages/TaskPage';
import { CommentPage } from './pages/CommentPage';
import { AttachmentPage } from './pages/AttachmentPage';
import { TagPage } from './pages/TagPage';
import { AuditPage } from './pages/AuditPage';
import { SettingPage } from './pages/SettingPage';
import { RolePage } from './pages/RolePage';
import { PermissionPage } from './pages/PermissionPage';
import { TeamPage } from './pages/TeamPage';
import { ContractPage } from './pages/ContractPage';
import { InvoiceLinePage } from './pages/InvoiceLinePage';
import { ShipmentLegPage } from './pages/ShipmentLegPage';
import { PaymentMethodPage } from './pages/PaymentMethodPage';
import { DiscountPage } from './pages/DiscountPage';
import { PromotionPage } from './pages/PromotionPage';
import { CampaignPage } from './pages/CampaignPage';
import { LeadPage } from './pages/LeadPage';
import { ContactPage } from './pages/ContactPage';
import { CompanyPage } from './pages/CompanyPage';
import { DealPage } from './pages/DealPage';
import { QuotePage } from './pages/QuotePage';
import { RenewalPage } from './pages/RenewalPage';
import { WebhookPage } from './pages/WebhookPage';
import { ApiKeyPage } from './pages/ApiKeyPage';
import { DevicePage } from './pages/DevicePage';

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
        <Route path="/addresss" element={<AddressPage />} />
        <Route path="/refunds" element={<RefundPage />} />
        <Route path="/tickets" element={<TicketPage />} />
        <Route path="/sessions" element={<SessionPage />} />
        <Route path="/reports" element={<ReportPage />} />
        <Route path="/vendors" element={<VendorPage />} />
        <Route path="/warehouses" element={<WarehousePage />} />
        <Route path="/employees" element={<EmployeePage />} />
        <Route path="/departments" element={<DepartmentPage />} />
        <Route path="/projects" element={<ProjectPage />} />
        <Route path="/tasks" element={<TaskPage />} />
        <Route path="/comments" element={<CommentPage />} />
        <Route path="/attachments" element={<AttachmentPage />} />
        <Route path="/tags" element={<TagPage />} />
        <Route path="/audits" element={<AuditPage />} />
        <Route path="/settings" element={<SettingPage />} />
        <Route path="/roles" element={<RolePage />} />
        <Route path="/permissions" element={<PermissionPage />} />
        <Route path="/teams" element={<TeamPage />} />
        <Route path="/contracts" element={<ContractPage />} />
        <Route path="/invoiceLines" element={<InvoiceLinePage />} />
        <Route path="/shipmentLegs" element={<ShipmentLegPage />} />
        <Route path="/paymentMethods" element={<PaymentMethodPage />} />
        <Route path="/discounts" element={<DiscountPage />} />
        <Route path="/promotions" element={<PromotionPage />} />
        <Route path="/campaigns" element={<CampaignPage />} />
        <Route path="/leads" element={<LeadPage />} />
        <Route path="/contacts" element={<ContactPage />} />
        <Route path="/companys" element={<CompanyPage />} />
        <Route path="/deals" element={<DealPage />} />
        <Route path="/quotes" element={<QuotePage />} />
        <Route path="/renewals" element={<RenewalPage />} />
        <Route path="/webhooks" element={<WebhookPage />} />
        <Route path="/apiKeys" element={<ApiKeyPage />} />
        <Route path="/devices" element={<DevicePage />} />
      </Routes>
    </BrowserRouter>
  );
}
