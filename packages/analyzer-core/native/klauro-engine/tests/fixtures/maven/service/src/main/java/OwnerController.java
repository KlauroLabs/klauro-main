package billing;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OwnerController {
    @GetMapping("/owners/{id}")
    public String find(String id) {
        return id;
    }
}
