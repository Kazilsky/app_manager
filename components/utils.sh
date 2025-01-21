
#!/bin/bash
# components/utils.sh

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Error handling
handle_error() {
    local exit_code=$1
    local error_msg=$2

    if [ $exit_code -ne 0 ]; then
        log "ERROR: $error_msg"
        echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: $error_msg" >> "$LOG_DIR/error.log"
        return 1
    fi
}

# Validation functions
validate_app_name() {
    local app_name="$1"
    if [[ ! "$app_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        log "Error: Invalid application name. Use only letters, numbers, dash and underscore"
        return 1
    fi
}

validate_app_exists() {
    local app_name="$1"
    if [ ! -d "$APPS_DIR/$app_name" ]; then
        log "Error: Application $app_name not found"
        return 1
    fi
}

validate_user_input() {
    local username="$1"
    local role="$2"
    local password="$3"

    if [ -z "$username" ] || [ -z "$role" ] || [ -z "$password" ]; then
        log "Error: Missing required parameters"
        return 1
    fi
}

# Package installation
install_package() {
    local package_name="$1"
    if ! command -v "$package_name" &> /dev/null; then
        log "Installing $package_name..."
        apt-get update && apt-get install -y "$package_name"
    fi
}

# Usage information
show_usage() {
    echo "Usage: $0 {user|group|app|backup|monitor|web|env} command [options]"
    echo "Type '$0 command --help' for more information about a command"
}

# Additional utility functions...
