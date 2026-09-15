class Session
  def close(force)
    if force
      return false
    end
    persist(@identifier)
  end

  def persist(id)
    id.empty?
  end
end
