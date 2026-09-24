class Api::V1::StatusesController < Api::BaseController
  before_action :set_status

  def show
    render json: @status
  end

  def destroy
    @status.destroy!
    render json: @status
  end

  private

  def set_status
    @status = Status.find(params[:id])
  end
end
