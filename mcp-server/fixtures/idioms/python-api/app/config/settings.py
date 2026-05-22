import os


DATABASE_URL = os.environ["DATABASE_URL"]
LOG_LEVEL = os.environ.get("LOG_LEVEL", "info")
