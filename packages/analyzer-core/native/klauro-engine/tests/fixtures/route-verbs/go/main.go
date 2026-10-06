package main

import (
	"net/http"

	"github.com/gorilla/mux"
)

func main() {
	r := mux.NewRouter()
	r.HandleFunc("/users", listUsers).Methods("GET")
	r.HandleFunc("/users", createUser).Methods("POST")
	http.ListenAndServe(":8080", r)
}

func listUsers(w http.ResponseWriter, req *http.Request)  {}
func createUser(w http.ResponseWriter, req *http.Request) {}
