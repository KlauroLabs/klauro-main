defmodule AppWeb.Router do
  scope "/", AppWeb do
    get "/about", PageController, :about
    post "/users", UserController, :create
  end
end
