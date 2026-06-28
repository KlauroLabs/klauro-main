from fastapi import FastAPI

app = FastAPI()


@app.get("/invoices")
def list_invoices():
    return []


@app.post("/invoices")
def create_invoice():
    return {"ok": True}
