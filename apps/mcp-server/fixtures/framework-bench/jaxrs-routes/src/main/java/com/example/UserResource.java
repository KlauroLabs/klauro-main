package com.example;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;

@Path("/users")
public class UserResource {

    @GET
    public java.util.List<String> list() {
        return null;
    }

    @POST
    public String create(String body) {
        return body;
    }

    @DELETE
    @Path("/{id}")
    public void remove(@PathParam("id") String id) {
    }
}
