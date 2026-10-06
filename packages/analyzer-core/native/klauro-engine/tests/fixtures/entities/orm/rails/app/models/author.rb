class Author < ApplicationRecord
  has_many :books
  has_one :profile, class_name: "AuthorProfile"
end
