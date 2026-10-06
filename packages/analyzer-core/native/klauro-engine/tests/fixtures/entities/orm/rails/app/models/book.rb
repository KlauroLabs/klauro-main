class Book < ApplicationRecord
  belongs_to :author
  has_and_belongs_to_many :tags
  belongs_to :imprint, polymorphic: true
end
