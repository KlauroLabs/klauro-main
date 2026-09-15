package store

import "net/http"

func Serve(mux *http.ServeMux) {
	mux.HandleFunc("GET /sessions/{id}", showSession)
	mux.HandleFunc("POST /sessions", createSession)
}

func showSession(w http.ResponseWriter, r *http.Request) {
	persist("read")
}

func createSession(w http.ResponseWriter, r *http.Request) {
	persist("write")
}
