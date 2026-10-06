(ns app.core
  (:require [reitit.ring :as ring]
            [ring.adapter.jetty :refer [run-jetty]]))

(defn list-users [request] {:status 200 :body "users"})
(defn create-user [request] {:status 201 :body "created"})
(defn show-user [request] {:status 200 :body "user"})
(defn health [request] {:status 200 :body "ok"})
(defn list-items [request] {:status 200 :body "items"})

(def routes
  ["/api"
   ["/users"
    {:get  {:handler list-users}
     :post {:handler create-user
            :middleware [wrap-auth]}}]
   ["/users/:id"
    {:get {:handler show-user}}]
   ["/health"
    {:get {:handler health}}]
   ["/v2"
    ["/items"
     {:get {:handler list-items}}]]])

(defn ring-only-handler [request]
  {:status 200 :body "ring-only, no router"})

(def app (ring/ring-handler (ring/router routes)))
