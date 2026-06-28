package shapes

// Shape is a duck-typed interface with two implementors + an unrelated decoy.
type Shape interface {
	Area() float64
}

type Circle struct{ R float64 }

func (c Circle) Area() float64 { return 3.14159 * c.R * c.R }

type Square struct{ S float64 }

func (s Square) Area() float64 { return s.S * s.S }

// TaxForm is a decoy: it does NOT satisfy the Shape interface (no Area method),
// so a Shape.Area() dispatch must never resolve to it. (Go is structurally typed,
// so a same-NAMED Area() here would actually satisfy Shape — to keep the decoy a
// true non-implementor it deliberately exposes a differently-named method.)
type TaxForm struct{}

func (t TaxForm) Total() float64 { return -1.0 }

// Render's parameter is the interface Shape, so shape.Area() dispatches to every
// concrete Shape implementor (Circle, Square).
func Render(shape Shape) float64 {
	return shape.Area()
}
