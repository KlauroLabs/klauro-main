package fixture;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/owners")
public class OwnerController {
    @GetMapping("/{ownerId}")
    public String findOwner(String ownerId) {
        return ownerId;
    }

    @PostMapping
    public String createOwner(String name) {
        return name;
    }
}
