#!/bin/sh

echo "Checking database schema..."

# Add scopes column if missing (safe with IF NOT EXISTS)
node scripts/migrate-scopes.js || {
    echo " Migration failed, but starting server anyway (column might already exist)"
}

echo "Starting server..."

# Start the application
exec node src/server.js
