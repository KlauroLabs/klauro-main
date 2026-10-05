import os
import subprocess

EXPORTER = os.path.join(os.path.dirname(__file__), "..", "tools", "exporter", "main.py")


def export():
    subprocess.run(["python3", EXPORTER, "--all"], check=True)
