from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response


@api_view(['GET', 'POST'])
def users(request):
    return Response([])


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def user_detail(request, id):
    return Response(status=204)
