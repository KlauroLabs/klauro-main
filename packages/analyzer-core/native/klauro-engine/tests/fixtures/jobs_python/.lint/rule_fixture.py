from shop.celeryconf import app


@app.task
def expire_carts():
    return 0


def plain_helper():
    return 1
