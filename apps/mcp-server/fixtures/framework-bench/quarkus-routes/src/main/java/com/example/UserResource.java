package com.example;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;

@Path("/users")
public class UserResource {

    @GET
    public Response list() {
        return Response.ok().build();
    }

    @POST
    public Response create(String body) {
        return Response.status(201).build();
    }

    @DELETE
    @Path("/{id}")
    public Response remove(@PathParam("id") Long id) {
        return Response.noContent().build();
    }
}
