#!/usr/bin/env bash
#
# setup.sh — One-command setup for the Deployment Gate Demo
#
# This script:
# 1. Starts a local server for the GitHub App manifest flow
# 2. Opens your browser to create the app
# 3. Saves the private key and .env automatically
# 4. Installs npm dependencies
# 5. Installs the app on the target repos
# 6. Enables the deployment protection rule on environments
#
# Usage:
#   ./setup.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║       Deployment Gate — Setup Wizard                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Install dependencies
echo "📦 Installing dependencies..."
npm install --silent 2>/dev/null
echo "   Done"
echo ""

# Step 2: Create the GitHub App
echo "🔑 Creating GitHub App..."
echo "   Starting local server for manifest flow..."
echo ""

node create-app.js &
SERVER_PID=$!
sleep 1

echo "   Opening browser..."
open "http://localhost:9876" 2>/dev/null || xdg-open "http://localhost:9876" 2>/dev/null || echo "   Please open http://localhost:9876 in your browser"

echo ""
echo "   👉 Click 'Create GitHub App' in your browser"
echo "   👉 Then click 'Create GitHub App' on GitHub"
echo "   👉 The app credentials will be saved automatically"
echo ""
echo "   Waiting for app creation..."

# Wait for the server to exit (it exits after successful creation)
wait $SERVER_PID 2>/dev/null || true

# Verify .env was created
if [ ! -f .env ]; then
  echo "❌ App creation failed or was cancelled."
  echo "   Please try again: ./setup.sh"
  exit 1
fi

APP_ID=$(grep APP_ID .env | cut -d= -f2)
echo "   ✅ App created! ID: $APP_ID"
echo ""

# Step 3: Install the app on repos
echo "🔗 Installing app on repos..."
echo "   Go to: https://github.com/organizations/joshjohanning-org/settings/installations"
echo "   Find 'Deployment Gate Demo' and configure it to have access to:"
echo "   - deployment-gate-app-demo"
echo ""
read -p "   Press Enter after installing the app on the repos..."

# Step 4: Enable deployment protection rule on environments
echo ""
echo "🛡️  Enabling deployment protection rule on environments..."

SLUG=$(grep -o 'slug.*' /tmp/create-app.log 2>/dev/null | head -1 || echo "")

echo ""
echo "   For each environment (QA, Staging, Production-East, Production-Central):"
echo "   1. Go to: https://github.com/joshjohanning-org/deployment-gate-app-demo/settings/environments"
echo "   2. Click the environment"
echo "   3. Under 'Deployment protection rules', enable 'Deployment Gate Demo'"
echo ""
read -p "   Press Enter after enabling the protection rules..."

# Step 5: Start the gate app
echo ""
echo "🚀 Starting the deployment gate app..."
echo ""
npm start
