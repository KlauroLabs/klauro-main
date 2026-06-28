package main

import "github.com/labstack/echo/v4"

func main() {
	e := echo.New()
	e.GET("/users", listUsers)
	e.POST("/users", createUser)
	e.DELETE("/users/:id", deleteUser)
	e.Start(":8080")
}

func listUsers(c echo.Context) error  { return c.JSON(200, nil) }
func createUser(c echo.Context) error { return c.JSON(201, nil) }
func deleteUser(c echo.Context) error { return c.NoContent(204) }
