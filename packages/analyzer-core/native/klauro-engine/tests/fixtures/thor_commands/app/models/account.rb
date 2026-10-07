class Account < ActiveRecord::Base
  def deactivate
    update!(active: false)
  end
end
