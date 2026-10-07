from flask import Flask

from app.orders import OrderRepository, OrderService

app = Flask(__name__)


@app.route("/orders")
def list_orders():
    return OrderService(OrderRepository()).list()
