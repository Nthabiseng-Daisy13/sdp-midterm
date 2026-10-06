#!/usr/bin/env bash
# start.sh — one-command setup and launch for the RAT dashboard.
#
# Usage:
#   chmod +x start.sh
#   ./start.sh
#
# Requirements: Python 3.11+, Node.js 18+, npm, git
# The server will be available at http://localhost:8000

set -euo pipefail
cd "$(dirname "$0")"

echo "==> Setting up Python virtual environment..."
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate

echo "==> Installing backend dependencies..."
pip install -q -r backend/requirements.txt

echo "==> Installing frontend dependencies..."
cd frontend
npm install --silent
echo "==> Building frontend..."
npm run build
cd ..

echo ""
echo "============================================"
echo "  RAT — Repo Analysis Tool"
echo "  Starting server at http://localhost:8000"
echo "============================================"
echo ""

exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend
