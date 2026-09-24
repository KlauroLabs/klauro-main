class CreateWebhooks < ActiveRecord::Migration[7.1]
  def change
    create_table :webhooks do |t|
      t.string :url
    end
    create_table :settings do |t|
      t.string :var
    end
  end
end
