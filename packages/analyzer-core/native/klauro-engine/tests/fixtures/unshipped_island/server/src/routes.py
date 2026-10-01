from flask import Blueprint

pages = Blueprint("pages", __name__)


@pages.route("/real")
def real():
    return "real"
