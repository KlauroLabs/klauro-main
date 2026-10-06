package main

import "github.com/gin-gonic/gin"

func AuthRequired() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }

func listUsers(c *gin.Context)  { c.JSON(200, nil) }
func adminUsers(c *gin.Context) { c.JSON(200, nil) }

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)

	admin := r.Group("/admin")
	admin.Use(AuthRequired())
	admin.GET("/users", adminUsers)
}
