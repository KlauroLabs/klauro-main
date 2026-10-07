#!/usr/bin/env python3
import os, shutil

def clean(path):
    for name in os.listdir(path):
        if name.endswith(".tmp"):
            os.remove(os.path.join(path, name))

if __name__ == "__main__":
    clean("/var/tmp")
