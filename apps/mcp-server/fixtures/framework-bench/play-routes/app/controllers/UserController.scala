package controllers

import javax.inject._
import play.api.mvc._

@Singleton
class UserController @Inject()(cc: ControllerComponents) extends AbstractController(cc) {

  def list() = Action {
    Ok("list")
  }

  def create() = Action {
    Ok("create")
  }

  def show(id: Long) = Action {
    Ok(s"show $id")
  }
}
