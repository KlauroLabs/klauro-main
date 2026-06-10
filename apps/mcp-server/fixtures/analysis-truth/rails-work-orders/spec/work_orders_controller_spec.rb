require 'rails_helper'

RSpec.describe WorkOrdersController, type: :controller do
  describe 'GET #index' do
    it 'returns open work orders' do
      get :index
      expect(response).to have_http_status(:ok)
    end
  end

  describe 'POST #create' do
    it 'creates a work order for a customer' do
      post :create, params: { work_order: { title: 'Fix pump', status: 'pending', customer_id: 1 } }
      expect(response).to have_http_status(:created)
    end
  end
end
