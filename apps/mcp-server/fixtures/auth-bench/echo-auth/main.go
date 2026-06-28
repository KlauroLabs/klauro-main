package main

import "github.com/labstack/echo/v4"

func AuthRequired(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error { return next(c) }
}

func listUsers(c echo.Context) error  { return c.JSON(200, nil) }
func createUser(c echo.Context) error { return c.JSON(201, nil) }
func deleteUser(c echo.Context) error { return c.NoContent(204) }

func main() {
	e := echo.New()
	e.GET("/users", listUsers)
	e.POST("/users", createUser, AuthRequired)
	e.DELETE("/users/:id", deleteUser, AuthRequired)
	e.Start(":8080")
}
