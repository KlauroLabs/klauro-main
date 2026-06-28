package main

import "github.com/gofiber/fiber/v2"

func main() {
	app := fiber.New()
	app.Get("/users", listUsers)
	app.Post("/users", createUser)
	app.Delete("/users/:id", deleteUser)
	app.Listen(":3000")
}

func listUsers(c *fiber.Ctx) error  { return c.JSON(nil) }
func createUser(c *fiber.Ctx) error { return c.SendStatus(201) }
func deleteUser(c *fiber.Ctx) error { return c.SendStatus(204) }
