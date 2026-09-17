import graphene

from .models import Product


class BaseObjectType(graphene.ObjectType):
    class Meta:
        abstract = True


class ProductType(BaseObjectType[Product]):
    def resolve_name(self, info):
        return Product.objects.filter(active=True).first()

    def helper(self):
        return 1
