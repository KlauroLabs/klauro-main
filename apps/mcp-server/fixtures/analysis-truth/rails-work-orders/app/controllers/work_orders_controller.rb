class WorkOrdersController < ApplicationController
  before_action :require_auth
  before_action :set_work_order, only: [:show, :update, :destroy]

  def index
    @work_orders = WorkOrder.open_orders
    render json: @work_orders
  end

  def show
    render json: @work_order
  end

  def create
    @work_order = WorkOrder.new(work_order_params)
    if @work_order.save
      render json: @work_order, status: :created
    else
      render json: @work_order.errors, status: :unprocessable_entity
    end
  end

  def update
    if @work_order.update(work_order_params)
      render json: @work_order
    else
      render json: @work_order.errors, status: :unprocessable_entity
    end
  end

  def destroy
    @work_order.destroy
    head :no_content
  end

  private

  def require_auth
    head :unauthorized unless current_user
  end

  def set_work_order
    @work_order = WorkOrder.find(params[:id])
  end

  def work_order_params
    params.require(:work_order).permit(:title, :status, :customer_id)
  end
end
