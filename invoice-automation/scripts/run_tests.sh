#!/usr/bin/env bash
# Run tests, lint and type checks.
set -euo pipefail
cd "$(dirname "$0")/.."
python -m pytest
ruff check src tests scripts
mypy src
