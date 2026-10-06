import strawberry


@strawberry.type
class User:
    id: strawberry.ID
    email: str


@strawberry.type
class Query:
    @strawberry.field
    def user(self, id: strawberry.ID) -> User:
        return find_user(id)

    @strawberry.field
    def users(self) -> list[User]:
        return all_users()


@strawberry.type
class Mutation:
    @strawberry.mutation
    def create_user(self, email: str) -> User:
        return make_user(email)
