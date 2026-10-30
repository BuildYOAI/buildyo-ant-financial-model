#!/usr/bin/env bash
# Copies the model engine and data into site/ (the deployable folder), after re-running the model checks.
set -e
cd "$(dirname "$0")/.."
node model/run.mjs > /dev/null
mkdir -p site/model site/data
cp model/engine.js site/model/engine.js
cp model/assumptions.json site/data/assumptions.json
cp data/historicals.json site/data/historicals.json
echo "site/ refreshed: engine + data copied; model checks passed."
