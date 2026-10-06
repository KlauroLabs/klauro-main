import graphene


class Order(graphene.ObjectType):
    id = graphene.ID()
    number = graphene.Int()
    status = graphene.String()
    total = graphene.Float()
    lines = graphene.List(graphene.String)
