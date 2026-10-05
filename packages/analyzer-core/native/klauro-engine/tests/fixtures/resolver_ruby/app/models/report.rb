class Report
  def chained
    Item.new.total
  end

  def literal
    'abc'.upcase
  end

  def library
    Item.where(id: 1)
  end
end
