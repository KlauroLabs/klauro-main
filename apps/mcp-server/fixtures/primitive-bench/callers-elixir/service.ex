defmodule Service do
  def persist(x) do
    Account.save(x)
  end
end
