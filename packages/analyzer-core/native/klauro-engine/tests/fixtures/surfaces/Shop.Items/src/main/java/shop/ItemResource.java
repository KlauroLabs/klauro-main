package shop;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/items")
public class ItemResource {
    @GET
    @Path("{id}")
    public String item(String id) {
        return id;
    }
}
