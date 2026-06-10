class CreateWorkOrders < ActiveRecord::Migration[7.1]
  def change
    create_table :work_orders do |t|
      t.string :title, null: false
      t.string :status, null: false, default: 'pending'
      t.references :customer, null: false, foreign_key: true
      t.timestamps
    end
  end
end
