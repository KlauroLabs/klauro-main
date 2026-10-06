import graphene
from django.db import models

from ..shop import models as shop_models


class ModelObjectType(graphene.ObjectType):
    pass


class BaseTranslationType(ModelObjectType):
    language = graphene.String()


class ProductTranslation(BaseTranslationType[shop_models.ProductTranslation]):
    title = graphene.String()
