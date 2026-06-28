package main

import "github.com/labstack/echo/v4"

func listUsers(c echo.Context) error  { return c.JSON(200, nil) }
func createUser(c echo.Context) error { return c.JSON(201, nil) }
func deleteUser(c echo.Context) error { return c.NoContent(204) }

func main() {
	e := echo.New()
	g := e.Group("/api/v1")
	g.GET("/users", listUsers)
	g.POST("/users", createUser)
	g.DELETE("/users/:id", deleteUser)
	e.Start(":8080")
}
