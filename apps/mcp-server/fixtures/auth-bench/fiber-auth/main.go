package main

import "github.com/gofiber/fiber/v2"

func AuthRequired(c *fiber.Ctx) error { return c.Next() }

func listUsers(c *fiber.Ctx) error  { return c.JSON(nil) }
func createUser(c *fiber.Ctx) error { return c.SendStatus(201) }
func deleteUser(c *fiber.Ctx) error { return c.SendStatus(204) }

func main() {
	app := fiber.New()
	app.Get("/users", listUsers)
	app.Post("/users", AuthRequired, createUser)
	app.Delete("/users/:id", AuthRequired, deleteUser)
	app.Listen(":3000")
}
