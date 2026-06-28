package main

import "github.com/gin-gonic/gin"

func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) { c.Next() }
}

func listUsers(c *gin.Context)  { c.JSON(200, []string{}) }
func createUser(c *gin.Context) { c.JSON(201, nil) }
func deleteUser(c *gin.Context) { c.Status(204) }

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)
	r.POST("/users", AuthRequired(), createUser)
	r.DELETE("/users/:id", AuthRequired(), deleteUser)
	r.Run()
}
