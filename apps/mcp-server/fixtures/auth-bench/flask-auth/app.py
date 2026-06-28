from flask import Flask, jsonify, request
from flask_login import login_required

app = Flask(__name__)


@app.route('/users', methods=['GET'])
def list_users():
    return jsonify([])


@app.route('/users', methods=['POST'])
@login_required
def create_user():
    return jsonify(request.json)


@app.route('/users/<int:id>', methods=['DELETE'])
@login_required
def delete_user(id):
    return ('', 204)
