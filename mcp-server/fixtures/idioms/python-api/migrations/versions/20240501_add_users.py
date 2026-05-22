def upgrade():
    op.create_table("users")


def downgrade():
    op.drop_table("users")
