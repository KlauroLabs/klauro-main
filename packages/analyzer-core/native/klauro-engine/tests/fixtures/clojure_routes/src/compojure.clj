(ns app.core
  (:require [compojure.core :refer [defroutes routes context GET POST PUT DELETE PATCH ANY]]
            [compojure.route :as route]
            [ring.middleware.defaults :refer [wrap-defaults site-defaults]]
            [buddy.auth.middleware :refer [wrap-authentication]]
            [buddy.auth.backends :as backends]))

(defn home [req] {:status 200 :body "home"})
(defn show [id] {:status 200 :body (str "user " id)})
(defn create [req] {:status 201 :body "created"})
(defn update-user [id req] {:status 200 :body "updated"})
(defn destroy [id] {:status 204})
(defn health [req] {:status 200 :body "ok"})
(defn make-item [req] {:status 201 :body "item"})
(defn list-items [req] {:status 200 :body "items"})
(defn ping [req] {:status 200 :body "pong"})

(defroutes app-routes
  (GET "/" [] home)
  (GET "/users/:id" [id] (show id))
  (POST "/users" req (create req))
  (PUT "/users/:id" [id :as req] (update-user id req))
  (DELETE "/users/:id" [id] (destroy id))
  (context "/api" []
    (GET "/health" [] health)
    (POST "/items" req (make-item req))
    (context "/v2" []
      (GET "/items" req (list-items req))))
  (ANY "/ping" [] ping)
  (route/not-found "Not Found"))

;; Auth is applied as Ring middleware on the whole handler, NOT per route.
;; The analyzer is honest about this: every route is emitted auth:false.
(def auth-backend (backends/session))

(def app
  (-> app-routes
      (wrap-authentication auth-backend)
      (wrap-defaults site-defaults)))
