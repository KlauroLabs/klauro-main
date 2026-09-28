from flask import Blueprint

pages = Blueprint("pages", __name__)


@pages.route("/reports/<key>", methods=["GET"])
@login_required
# pylint: disable=unused-argument
def report(key):
    return render_report(key)


@pages.route("/plain")
def plain():
    return "plain"
