class Api::V1::Statuses::FavouritesController < Api::BaseController
  def create
    Favourite.create!(status_id: params[:status_id])
  end

  def destroy
    Favourite.where(status_id: params[:status_id]).destroy_all
  end
end
