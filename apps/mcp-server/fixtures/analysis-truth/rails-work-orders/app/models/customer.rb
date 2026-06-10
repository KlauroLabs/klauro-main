class Customer < ApplicationRecord
  has_many :work_orders, dependent: :destroy

  validates :name, presence: true
  validates :email, presence: true, uniqueness: true

  def open_work_orders
    work_orders.open_orders
  end
end
