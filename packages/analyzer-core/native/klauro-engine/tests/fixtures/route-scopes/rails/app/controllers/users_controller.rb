class UsersController < ApplicationController
  before_action :authenticate_user!, only: [:create]

  def index
    render json: []
  end

  def create
    head :created
  end
end
