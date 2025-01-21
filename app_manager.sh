
#!/bin/bash

# Core configuration component
source components/config.sh
# User management component
source components/user_manager.sh
# Group management component
source components/group_manager.sh
# Application management component
source components/app_manager.sh
# Docker management component
source components/docker_manager.sh
# Nginx and SSL management component
source components/web_manager.sh
# Backup and restore component
source components/backup_manager.sh
# Monitoring and logging component
source components/monitor_manager.sh
# Environment variables management component
source components/env_manager.sh
# Error handling and utilities component
source components/utils.sh

# Main script
main() {
    case "$1" in
        user)
            handle_user_command "${@:2}"
            ;;
        group)
            handle_group_command "${@:2}"
            ;;
        app)
            handle_app_command "${@:2}"
            ;;
        backup)
            handle_backup_command "${@:2}"
            ;;
        monitor)
            handle_monitor_command "${@:2}"
            ;;
        web)
            handle_web_command "${@:2}"
            ;;
        env)
            handle_env_command "${@:2}"
            ;;
        *)
            show_usage
            exit 1
            ;;
    esac
}

# Start the script
main "$@"
