class WorkOrder < ApplicationRecord
  STATUSES = %w[pending in_progress completed].freeze

  belongs_to :customer

  validates :title, presence: true
  validates :status, inclusion: { in: STATUSES }

  scope :open_orders, -> { where.not(status: 'completed') }

  before_save :normalize_title

  def completed?
    status == 'completed'
  end

  private

  def normalize_title
    self.title = title.strip
  end
end
