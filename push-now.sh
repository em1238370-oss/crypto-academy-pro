#!/bin/sh
# Run this after AI completes a task — pushes to GitHub
cd "$(dirname "$0")"
git push origin main
