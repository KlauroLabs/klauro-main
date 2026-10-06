package main

import "github.com/labstack/echo/v4"

func AuthRequired(next echo.HandlerFunc) echo.HandlerFunc { return next }
func list(c echo.Context) error { return nil }
func adminList(c echo.Context) error { return nil }

func main() {
	e := echo.New()
	e.GET("/users", list)
	admin := e.Group("/admin", AuthRequired)
	admin.GET("/users", adminList)
	v1 := e.Group("/v1")
	v1.Use(AuthRequired)
	v1.GET("/x", list)
}
