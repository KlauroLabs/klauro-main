package controllers

class UserController {
  def list() = Action { Ok("list") }
  def show(id: Long) = Action { Ok("show") }
  def create() = Action { Ok("create") }
}
