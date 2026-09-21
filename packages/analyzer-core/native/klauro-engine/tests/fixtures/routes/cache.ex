defmodule AppWeb.Cache do
  def warm(store, conn) do
    get(store, "session/token", conn)
  end
end
