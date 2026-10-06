from rest_framework.decorators import api_view
from rest_framework.views import APIView


@api_view(['GET', 'POST'])
def users(request):
    return None


@api_view(['DELETE'])
def user_detail(request, id):
    return None


class ItemView(APIView):
    def get(self, request):
        return None

    def post(self, request):
        return None
