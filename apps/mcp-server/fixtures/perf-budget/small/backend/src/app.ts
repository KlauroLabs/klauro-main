import express from 'express';
import { userRouter } from './routes/user.routes';
import { orderRouter } from './routes/order.routes';
import { productRouter } from './routes/product.routes';
import { invoiceRouter } from './routes/invoice.routes';
import { paymentRouter } from './routes/payment.routes';
import { customerRouter } from './routes/customer.routes';
import { shipmentRouter } from './routes/shipment.routes';
import { inventoryRouter } from './routes/inventory.routes';
import { reviewRouter } from './routes/review.routes';
import { categoryRouter } from './routes/category.routes';
import { cartRouter } from './routes/cart.routes';
import { couponRouter } from './routes/coupon.routes';
import { subscriptionRouter } from './routes/subscription.routes';
import { notificationRouter } from './routes/notification.routes';

export const app = express();
app.use(express.json());

app.use('/api/users', userRouter);
app.use('/api/orders', orderRouter);
app.use('/api/products', productRouter);
app.use('/api/invoices', invoiceRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/customers', customerRouter);
app.use('/api/shipments', shipmentRouter);
app.use('/api/inventorys', inventoryRouter);
app.use('/api/reviews', reviewRouter);
app.use('/api/categorys', categoryRouter);
app.use('/api/carts', cartRouter);
app.use('/api/coupons', couponRouter);
app.use('/api/subscriptions', subscriptionRouter);
app.use('/api/notifications', notificationRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
