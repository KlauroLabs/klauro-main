defmodule MyApp.Accounts do
  @moduledoc "Accounts"
  use GenServer
  alias MyApp.Repo
  import MyApp.Helpers

  def save(attrs) do
    attrs |> normalize() |> Repo.insert()
  end

  defp normalize(attrs) when is_map(attrs), do: helper(attrs)
end
