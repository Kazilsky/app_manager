#!/bin/bash
# components/app_manager.sh

source components/config.sh
source components/utils.sh
source components/docker_manager.sh

handle_app_command() {
    case "$1" in
        create)
            create_app "$2" "$3" "$4"
            ;;
        update)
            update_app "$2" "$3"
            ;;
        delete)
            delete_app "$2"
            ;;
        restart)
            restart_app "$2"
            ;;
        status)
            show_app_status "$2"
            ;;
        *)
            show_app_usage
            return 1
            ;;
    esac
}

create_app() {
    local app_name="$1"
    local repo_url="$2"
    local branch="${3:-main}"

    # Validation
    validate_app_name "$app_name" || return 1

    log "Creating application $app_name from repository $repo_url (branch: $branch)"

    # Create system user
    create_app_user "$app_name" || return 1

    # Clone repository
    git clone -b "$branch" "$repo_url" "$APPS_DIR/$app_name" || return 1

    # Detect application type
    local app_type=$(detect_app_type "$APPS_DIR/$app_name")

    # Generate necessary files
    generate_dockerfile "$APPS_DIR/$app_name" "$app_type"
    generate_docker_compose "$APPS_DIR/$app_name" "$app_name" "$app_type"

    # Set permissions
    set_app_permissions "$app_name"

    # Start application
    (cd "$APPS_DIR/$app_name" && docker-compose up -d)

    show_app_info "$app_name" "$app_type"
}

detect_app_type() {
    local app_dir="$1"

    # Python detection
    if [ -f "$app_dir/requirements.txt" ] || [ -f "$app_dir/setup.py" ] || [ -f "$app_dir/Pipfile" ]; then
        echo "python"
        return
    fi

    # Node.js detection
    if [ -f "$app_dir/package.json" ]; then
        echo "nodejs"
        return
    fi

    # PHP detection
    if [ -f "$app_dir/composer.json" ] || find "$app_dir" -name "*.php" -quit; then
        echo "php"
        return
    fi

    # Go detection
    if [ -f "$app_dir/go.mod" ] || find "$app_dir" -name "*.go" -quit; then
        echo "golang"
        return
    fi

    echo "static"
}

# Additional application management functions...
