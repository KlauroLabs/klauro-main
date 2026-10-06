module Types
  class MutationType < Types::BaseObject
    field :create_user, mutation: Mutations::CreateUser
    field :search, resolver: Resolvers::Search
    field :ping, String, null: false, method: :ping_it
    field :posts, [PostType], null: false
  end
end
module Mutations
  class CreateUser < BaseMutation
    def resolve(email:)
      1
    end
  end
end
