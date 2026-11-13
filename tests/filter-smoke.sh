#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sed 's@/src/main.ts@/tests/filter-harness.ts@' index.html > filter-test.html
./node_modules/.bin/vite --host 127.0.0.1 --port 1462 --strictPort > /dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -f filter-test.html' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:1462/filter-test.html > /dev/null 2>&1; then break; fi
  sleep .2
done
swift tests/filter-smoke.swift http://127.0.0.1:1462/filter-test.html
