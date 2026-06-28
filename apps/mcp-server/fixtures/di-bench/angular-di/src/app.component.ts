import { Component } from '@angular/core';
import { UserService } from './user.service';

@Component({
  selector: 'app-root',
  template: `<div></div>`,
})
export class AppComponent {
  constructor(private readonly userService: UserService) {}
  list() { return this.userService.findAll(); }
}
