from flask import Blueprint

pages = Blueprint("pages", __name__)


@pages.route("/hidden")
def hidden():
    return "hidden"
