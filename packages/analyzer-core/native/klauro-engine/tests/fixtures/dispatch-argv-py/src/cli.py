import sys


def main():
    command = sys.argv[1]
    if command == "sync":
        do_sync()
    if command == "status":
        do_status()


def do_sync():
    print("syncing")


def do_status():
    print("status")


def configure(mode):
    if mode == "fast":
        return True
    return mode == "slow"
