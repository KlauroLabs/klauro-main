defmodule Shop.Api.Orders.OrderController do
  def index(conn, _params), do: conn
  def create(conn, _params), do: conn
end

defmodule Shop.Api.OrderController do
  def health(conn, _params), do: conn
end

defmodule Shop.Api.StatusController do
  def show(conn, _params), do: conn
end

defmodule Shop.PageController do
  def home(conn, _params), do: conn
end
