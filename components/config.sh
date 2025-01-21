#!/bin/bash
# components/config.sh

# Base directories
CONFIG_DIR="/etc/app-manager"
APPS_DIR="/var/www/apps"
HOOKS_DIR="/etc/app-manager/hooks"
APPS_CONFIG_DIR="/etc/app-manager/apps"
TEMPLATES_DIR="/etc/app-manager/templates"
BACKUP_DIR="/var/backups/app-manager"
LOG_DIR="/var/log/app-manager"
LOG_FILE="$LOG_DIR/app-manager.log"

# Web server directories
SYSTEMD_DIR="/etc/systemd/system"
NGINX_SITES_DIR="/etc/nginx/sites-available"
NGINX_ENABLED_DIR="/etc/nginx/sites-enabled"

# User management directories
USERS_DIR="/etc/app-manager/users"
ROLES_FILE="/etc/app-manager/roles.json"

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Initialize directories
setup_directories() {
    for dir in "$CONFIG_DIR" "$APPS_DIR" "$HOOKS_DIR" "$APPS_CONFIG_DIR" \
               "$TEMPLATES_DIR" "$BACKUP_DIR" "$LOG_DIR" "$NGINX_SITES_DIR" \
               "$NGINX_ENABLED_DIR" "$USERS_DIR"; do
        mkdir -p "$dir"
        chmod 755 "$dir"
    done
}