import graphene


class ModelMutation(graphene.Mutation):
    @classmethod
    def perform_mutation(cls, root, info, **data):
        return cls.save(info)


class PageCreate(ModelMutation):
    class Arguments:
        title = graphene.String()


class PageMutations(graphene.ObjectType):
    page_create = PageCreate.Field()


class Mutation(PageMutations, graphene.ObjectType):
    pass
