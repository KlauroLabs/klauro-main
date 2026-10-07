#!/bin/bash
set -e
pg_dump "$DATABASE_URL" > backup.sql
aws s3 cp backup.sql s3://acme-backups/
