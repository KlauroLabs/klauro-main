package main

import "github.com/gin-gonic/gin"

func listItems(c *gin.Context) {}

func main() {
	router := gin.Default()
	api := router.Group("/api")
	v1 := api.Group("/v1")
	v1.GET("/items", listItems)
	router.Run()
}
