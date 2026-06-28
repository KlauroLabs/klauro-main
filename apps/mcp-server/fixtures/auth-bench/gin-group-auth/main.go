package main

import "github.com/gin-gonic/gin"

func AuthRequired() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }

func listUsers(c *gin.Context)  { c.JSON(200, nil) }
func adminUsers(c *gin.Context) { c.JSON(200, nil) }
func deleteUser(c *gin.Context) { c.Status(204) }

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)

	admin := r.Group("/admin")
	admin.Use(AuthRequired())
	admin.GET("/users", adminUsers)
	admin.DELETE("/users/:id", deleteUser)

	r.Run()
}
