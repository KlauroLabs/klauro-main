package main

import "github.com/gin-gonic/gin"

func listUsers(c *gin.Context)  { c.JSON(200, []string{}) }
func createUser(c *gin.Context) { c.JSON(201, nil) }
func deleteUser(c *gin.Context) { c.Status(204) }

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)
	r.POST("/users", createUser)
	r.DELETE("/users/:id", deleteUser)
	r.Run()
}
