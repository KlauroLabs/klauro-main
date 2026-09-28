package main

import "os"

func main() {
	command := os.Args[1]
	if command == "serve" {
		serve()
	}
	if command == "migrate" {
		migrate()
	}
}

func serve() {
	println("serving")
}

func migrate() {
	println("migrating")
}

func configure(mode string) bool {
	if mode == "fast" {
		return true
	}
	return mode == "slow"
}
