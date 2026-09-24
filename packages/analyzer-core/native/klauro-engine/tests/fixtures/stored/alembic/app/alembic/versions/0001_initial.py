import sqlalchemy as sa
from alembic import op


def upgrade():
    op.create_table(
        "dashboards",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("dashboard_title", sa.String(length=500)),
    )
