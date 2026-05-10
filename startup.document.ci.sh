#!/usr/bin/env bash
set -e

/opt/wait-for-it.sh -t 120 mongo:27017
/opt/wait-for-it.sh -t 120 redis:6379
npm run seed:run:document
npm run start:prod > prod.log 2>&1 &
/opt/wait-for-it.sh -t 120 maildev:1080
/opt/wait-for-it.sh -t 180 localhost:3000
npm run lint
npm run test:e2e -- --runInBand
