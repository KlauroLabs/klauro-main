import graphene


class User(graphene.ObjectType):
    id = graphene.ID()
    email = graphene.String()


class Query(graphene.ObjectType):
    user = graphene.Field(User, id=graphene.ID(required=True))
    users = graphene.List(User)
    me = graphene.Field(User)

    def resolve_user(self, info, id):
        return find_user(id)

    def resolve_users(self, info):
        return all_users()

    def resolve_me(self, info):
        return current_user(info)
