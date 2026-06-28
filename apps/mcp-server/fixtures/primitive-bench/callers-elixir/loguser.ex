defmodule LogUser do
  def log_it(x) do
    Logger.save(x)
  end
end
