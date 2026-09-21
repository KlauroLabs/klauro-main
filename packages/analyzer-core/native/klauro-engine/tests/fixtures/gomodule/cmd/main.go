package main

import (
	"fmt"

	"github.com/spf13/cobra"

	"example.com/tool/internal/store"
)

func main() {
	opened := store.Open("local")
	command := &cobra.Command{Use: opened.Name}
	fmt.Println(command.Use)
}
