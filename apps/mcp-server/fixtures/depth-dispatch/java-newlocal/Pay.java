package pay;

/** Interface with two impls; the call site narrows to ONE via the constructor. */
interface PaymentGateway {
    boolean charge(int cents);
}

class StripeGateway implements PaymentGateway {
    public boolean charge(int cents) { return cents > 0; }
}

class PaypalGateway implements PaymentGateway {
    public boolean charge(int cents) { return cents >= 0; }
}

/** Decoy: same-named `charge` but NOT a PaymentGateway. Must be excluded. */
class Battery {
    public boolean charge(int cents) { return true; }
}

class Checkout {
    /**
     * The dispatch call site: the receiver is a LOCAL constructed as
     * `new StripeGateway()`, so the precise dispatch target is StripeGateway.charge
     * ONLY — not PaypalGateway.charge, and never Battery.charge.
     */
    boolean run() {
        PaymentGateway gw = new StripeGateway();
        return gw.charge(500);
    }
}
