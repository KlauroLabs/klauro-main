from rest_framework.decorators import api_view
from rest_framework.response import Response


@api_view(['GET', 'POST'])
def users(request):
    return Response([])


@api_view(['DELETE'])
def user_detail(request, id):
    return Response(status=204)
