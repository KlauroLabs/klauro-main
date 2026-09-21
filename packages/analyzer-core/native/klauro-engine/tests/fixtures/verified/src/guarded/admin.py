from flask import Blueprint

from src.store import open_store

admin = Blueprint("admin", __name__)


def login_required(view):
    return view


@admin.route("/admin/stores")
@login_required
def list_stores():
    return open_store("admin").slug()


@admin.route("/admin/health")
def admin_health():
    return "ok"
