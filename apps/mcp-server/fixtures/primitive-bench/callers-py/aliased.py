from account import Account as Acct

def archive(x: Acct) -> None:
    x.save()
