from flask import Blueprint

demo = Blueprint("demo", __name__)


@demo.route("/demo")
def show():
    return "demo"
