package wishlist

type Cart struct {
	items []string
}

func NewCart() *Cart {
	return &Cart{}
}

func (c *Cart) Total() int {
	return len(c.items)
}

func (c *Cart) Add(item string) {
	c.items = append(c.items, item)
}

func discount(count int) int {
	return count * 2
}

func (c *Cart) Error() string {
	return "wishlist"
}
