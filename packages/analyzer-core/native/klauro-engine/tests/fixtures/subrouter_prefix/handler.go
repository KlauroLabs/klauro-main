package api

import (
	"net/http"

	"github.com/gorilla/mux"
)

type Handler struct{ base string }

func (h Handler) CreateRouter() *mux.Router {
	router := mux.NewRouter().UseEncodedPath()

	apiRouter := router.PathPrefix(h.base).Subrouter().UseEncodedPath()

	apiRouter.Methods(http.MethodGet).Path("/api/rawdata").HandlerFunc(h.getRuntimeConfiguration)
	apiRouter.Methods(http.MethodGet).Path("/api/overview").HandlerFunc(h.getOverview)

	return router
}

func (h Handler) getRuntimeConfiguration(rw http.ResponseWriter, request *http.Request) {}

func (h Handler) getOverview(rw http.ResponseWriter, request *http.Request) {}
