module Types
  class QueryType < Types::BaseObject
    field :user, Types::UserType, null: true do
      argument :id, ID
    end
    field :users, [Types::UserType], null: false
    def user(id:)
      User.find(id)
    end
    def users
      User.all
    end
  end
end
