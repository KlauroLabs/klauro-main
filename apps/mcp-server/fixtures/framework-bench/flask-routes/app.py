from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route('/users', methods=['GET'])
def list_users():
    return jsonify([])


@app.route('/users', methods=['POST'])
def create_user():
    return jsonify(request.json)


@app.route('/users/<int:id>', methods=['DELETE'])
def delete_user(id):
    return ('', 204)
