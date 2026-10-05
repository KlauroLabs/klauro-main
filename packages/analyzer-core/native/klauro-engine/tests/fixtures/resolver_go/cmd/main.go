package main

import (
	"example.com/shop/pkg/cart"
	"example.com/shop/pkg/wishlist"
)

func fill() int {
	c := cart.NewCart()
	c.Add("pen")
	return c.Total()
}

func loaded() int {
	c, err := cart.Load("1")
	if err != nil {
		return 0
	}
	return c.Total()
}

func other() int {
	w := wishlist.NewCart()
	w.Add("book")
	return w.Total()
}

func main() {
	fill()
	loaded()
	other()
}
