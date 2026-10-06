defmodule Shop.Router do
  use Shop, :router

  scope "/api", Shop.Api do
    pipe_through :api

    scope "/v1", Orders, assigns: %{shop: true} do
      get "/orders", OrderController, :index
      post "/orders", OrderController, :create
    end

    scope path: "/plugins" do
      get "/status", StatusController, :show
    end

    scope [] do
      get "/health", OrderController, :health
    end
  end

  get "/", PageController, :home
end
