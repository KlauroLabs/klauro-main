class LegacyPaymentApi { charge(cents: number) {} }
export class PaymentAdapter {
  constructor(private legacy: LegacyPaymentApi) {}
  pay(dollars: number) { this.legacy.charge(dollars * 100); }
}
export class CheckoutFacade {
  constructor(private payment: PaymentAdapter) {}
  checkout(amount: number) { this.payment.pay(amount); }
}
