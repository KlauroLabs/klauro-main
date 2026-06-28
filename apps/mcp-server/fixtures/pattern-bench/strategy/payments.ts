export interface PaymentStrategy { pay(amount: number): void; }
export class CreditCardStrategy implements PaymentStrategy { pay(amount: number) {} }
export class PayPalStrategy implements PaymentStrategy { pay(amount: number) {} }
export class CryptoStrategy implements PaymentStrategy { pay(amount: number) {} }
export class Checkout {
  constructor(private strategy: PaymentStrategy) {}
  process(amount: number) { this.strategy.pay(amount); }
}
