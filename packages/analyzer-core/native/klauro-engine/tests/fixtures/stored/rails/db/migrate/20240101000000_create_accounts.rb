class CreateAccounts < ActiveRecord::Migration[7.1]
  def change
    create_table :accounts do |t|
      t.string :username, null: false
      t.string :email
      t.timestamps
    end
    create_table :status_edits do |t|
      t.references :account
      t.text :text
    end
  end
end
