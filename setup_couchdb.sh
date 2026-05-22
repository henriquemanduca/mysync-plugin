#!/usr/bin/env bash

# ==========================================
# CouchDB User Configuration Script
# ==========================================

set -a
# Load the .env file (adjust the path if necessary)
source .env
set +a

# ==========================================
# Function to Check Connection
# ==========================================
check_couchdb_connection() {
    echo "Checking connection to CouchDB..."

    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -u "$COUCH_ADMIN_USER:$COUCH_ADMIN_PASS" \
        --connect-timeout 10 \
        "$COUCH_HOST/_users")

    if [ "$HTTP_CODE" = "200" ]; then
        echo "Connection OK."
        return 0
    else
        echo "Connection failed. HTTP_CODE=$HTTP_CODE"
        return 1
    fi
}

# ==========================================
# Function to Create Plugin User
# ==========================================
create_plugin_user() {
    echo "Creating a plugin user: $COUCH_PLUGIN_USER..."
    curl -u "$COUCH_ADMIN_USER":"$COUCH_ADMIN_PASS" \
         -X PUT "$COUCH_HOST/_users/org.couchdb.user:$COUCH_PLUGIN_USER" \
         -H "Content-Type: application/json" \
         -d "{
          \"name\": \"$COUCH_PLUGIN_USER\",
          \"type\": \"user\",
          \"roles\": [\"$COUCH_PLUGIN_ROLE\"],
          \"password\": \"$COUCH_PLUGIN_PASS\"
        }" || echo "Failed to create user"
    echo ""
}

# ==========================================
# Function to Configure Database Security
# ==========================================
set_db_security() {
    echo "Configuring database security: $COUCH_DB..."
    curl -u "$COUCH_ADMIN_USER":"$COUCH_ADMIN_PASS" \
         -X PUT "$COUCH_HOST/$COUCH_DB/_security" \
         -H "Content-Type: application/json" \
         -d "{
          \"admins\": {
            \"names\": [],
            \"roles\": []
          },
          \"members\": {
            \"names\": [],
            \"roles\": [\"$COUCH_PLUGIN_ROLE\"]
          }
        }" || echo "Failed to configure security."
    echo ""
}

main() {
    check_couchdb_connection

    if [ $? -eq 0 ]; then
        create_plugin_user
        set_db_security
        echo "Configuration completed successfully!"
    else
        echo "Error: Could not connect to CouchDB."
        exit 1
    fi
}

# Run main function.
main
