class Library::ImportWorker
  include Sidekiq::Worker

  def perform(batch_id)
    Library::ImportService.new.call(batch_id)
  end
end
