package shapes;

/** Interface with two concrete implementations + an unrelated decoy. */
interface Shape {
    double area();
}

class Circle implements Shape {
    public double area() { return 3.14159; }
}

class Square implements Shape {
    public double area() { return 16.0; }
}

/**
 * Decoy: NOT a Shape. Has a same-named `area()` method, but a polymorphic
 * `Shape.area()` dispatch must NEVER resolve to this one.
 */
class TaxForm {
    public double area() { return -1.0; }
}

class Renderer {
    /**
     * The dispatch call site: `shape` is statically typed `Shape`, so this
     * polymorphic call dispatches to EVERY concrete Shape impl (Circle, Square),
     * and to neither the interface stub nor the unrelated TaxForm.area decoy.
     */
    double render(Shape shape) {
        return shape.area();
    }
}
