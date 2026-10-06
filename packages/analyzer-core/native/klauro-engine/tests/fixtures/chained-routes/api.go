package api

import (
	"net/http"

	"github.com/gorilla/mux"
)

type Handler struct{}

func (h Handler) Append(router *mux.Router) {
	router.Methods(http.MethodGet).Path("/api/overview").HandlerFunc(h.getOverview)
	router.Methods(http.MethodPut).Path("/api/providers/{provider}").HandlerFunc(h.putProvider)
}

func (h Handler) getOverview(w http.ResponseWriter, r *http.Request) {}

func (h Handler) putProvider(w http.ResponseWriter, r *http.Request) {}
