from ariadne import QueryType, MutationType

query = QueryType()
mutation = MutationType()


@query.field("user")
def resolve_user(_, info, id):
    return {"id": id}


@query.field("users")
def resolve_users(_, info):
    return []


@mutation.field("createUser")
def resolve_create_user(_, info, email):
    return {"email": email}
