package main

import (
	"net/http"

	"github.com/gorilla/mux"
)

func listUsers(w http.ResponseWriter, r *http.Request)  {}
func createUser(w http.ResponseWriter, r *http.Request) {}
func deleteUser(w http.ResponseWriter, r *http.Request) {}

func main() {
	r := mux.NewRouter()
	api := r.PathPrefix("/api/v1").Subrouter()
	api.HandleFunc("/users", listUsers).Methods("GET")
	api.HandleFunc("/users", createUser).Methods("POST")
	api.HandleFunc("/users/{id}", deleteUser).Methods("DELETE")
	http.ListenAndServe(":8080", r)
}
