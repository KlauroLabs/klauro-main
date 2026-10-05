package cart

type Cart struct {
	items []string
}

func NewCart() *Cart {
	return &Cart{}
}

func Load(id string) (*Cart, error) {
	return NewCart(), nil
}
