defmodule MyAppWeb.AccountController do
  alias MyApp.Accounts

  def create(params) do
    Accounts.save(params)
  end
end
