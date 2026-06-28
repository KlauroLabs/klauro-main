class LogUser
  def log_it
    l = Logger.new
    l.save()
  end
end
