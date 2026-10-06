class Order < ApplicationRecord
  validates :number, presence: true
end
