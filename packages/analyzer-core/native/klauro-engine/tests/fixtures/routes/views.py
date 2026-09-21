def about(request):
    return request


def fallback(request):
    return request


def read_amount(payload):
    return payload.get("amount", fallback)
