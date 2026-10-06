from django.urls import path
from . import views

urlpatterns = [
    path('users', views.users),
    path('users/<int:id>', views.user_detail),
    path('items', views.ItemView.as_view()),
]
