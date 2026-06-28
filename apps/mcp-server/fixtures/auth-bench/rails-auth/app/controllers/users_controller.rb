class UsersController < ApplicationController
  before_action :authenticate_user!, only: [:create, :destroy]

  def index
    render json: User.all
  end

  def create
    render json: User.create(user_params)
  end

  def destroy
    User.find(params[:id]).destroy
    head :no_content
  end
end
