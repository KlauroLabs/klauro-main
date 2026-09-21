from flask import Flask

from src.store import open_store

app = Flask(__name__)


@app.route("/stores/<name>")
def read_store(name):
    return open_store(name).slug()


@app.route("/health")
def health():
    return "ok"
