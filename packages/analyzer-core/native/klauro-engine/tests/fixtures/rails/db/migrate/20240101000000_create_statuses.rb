class CreateStatuses < ActiveRecord::Migration[7.1]
  def change
    create_table :statuses do |t|
      t.text :text
    end
    create_table :favourites do |t|
      t.bigint :status_id
    end
  end
end
