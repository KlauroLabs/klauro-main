class Report < ActiveRecord::Base
  def perform
    touch
  end
end
