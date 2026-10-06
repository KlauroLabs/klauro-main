import graphene
from graphene import relay

class BaseMutation(graphene.Mutation):
    class Meta:
        abstract = True
    @classmethod
    def mutate(cls, root, info, **data):
        return cls.perform_mutation(root, info, **data)

class ProductCreate(BaseMutation):
    class Arguments:
        name = graphene.String()
    @classmethod
    def perform_mutation(cls, root, info, **data):
        return ProductCreate()

class ProductMutations(graphene.ObjectType):
    product_create = ProductCreate.Field()

class ProductQueries(graphene.ObjectType):
    product = graphene.Field(graphene.String, id=graphene.ID())
    def resolve_product(self, info, id):
        return None

class Query(ProductQueries, graphene.ObjectType):
    pass

class Mutation(ProductMutations, graphene.ObjectType):
    pass
