defmodule MyApp.MixProject do
  use Mix.Project
  def project, do: [app: :my_app, deps: deps()]
  defp deps, do: [{:phoenix, "~> 1.7"}]
end
