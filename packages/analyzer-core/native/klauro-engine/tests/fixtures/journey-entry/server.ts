import express from "express";
import { launch } from "./jobs";

const app = express();

async function placeOrder(request: any, response: any) {
  launch(request.body);
  response.end();
}

app.post("/orders", placeOrder);
app.listen(3000);
