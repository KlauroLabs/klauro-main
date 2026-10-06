class PostsController < ApplicationController
  before_action :authenticate_user!, only: [:index]
  before_action :set_policy, only: [:index]
  before_action :cache_even_if_authenticated!, only: [:index]
  before_action :set_role, only: [:show]
  before_action :check_authorization, only: [:show]
  before_action :require_authenticated_user!, only: [:secret]

  def index
    render json: []
  end

  def show
    render json: {}
  end

  def secret
    render json: {}
  end

  private

  def set_policy
    @policy = Policy.find(params[:policy_id])
  end

  def set_role
    @role = Role.find(params[:id])
  end

  def cache_even_if_authenticated!
    expires_in(5.minutes, public: true) unless limited_mode?
  end

  def check_authorization
    @unauthorized = signed_request_account.nil?
  end

  def require_authenticated_user!
    render json: { error: 'authentication required' }, status: 401 unless current_user
  end
end
