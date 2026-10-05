package cart

func (c *Cart) Total() int {
	return discount(len(c.items))
}

func (c *Cart) Add(item string) {
	c.items = append(c.items, item)
	c.Total()
}
