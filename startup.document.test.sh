#!/usr/bin/env bash
set -e

/opt/wait-for-it.sh mongo:27017
/opt/wait-for-it.sh redis:6379
/opt/wait-for-it.sh maildev:1080
npm ci --legacy-peer-deps
npm run seed:run:document
npm run start:dev
