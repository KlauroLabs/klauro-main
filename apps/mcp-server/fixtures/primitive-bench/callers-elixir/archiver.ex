defmodule Archiver do
  def archive(x) do
    Account.save(x)
  end
end
