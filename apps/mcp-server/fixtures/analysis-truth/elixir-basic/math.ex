defmodule App.Math do
  def add(a, b), do: sum(a, b)
  defp sum(a, b), do: a + b
end
defmodule App.Server do
  use GenServer
  def init(state), do: {:ok, state}
end
