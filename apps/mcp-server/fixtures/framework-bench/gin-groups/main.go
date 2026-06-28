package main

import "github.com/gin-gonic/gin"

func listUsers(c *gin.Context)  { c.JSON(200, nil) }
func createUser(c *gin.Context) { c.JSON(201, nil) }
func deleteUser(c *gin.Context) { c.Status(204) }

func main() {
	r := gin.Default()
	v1 := r.Group("/api/v1")
	v1.GET("/users", listUsers)
	v1.POST("/users", createUser)
	v1.DELETE("/users/:id", deleteUser)
	r.Run()
}
