#!/bin/bash
# components/user_manager.sh

source components/config.sh
source components/utils.sh

init_user_system() {
    mkdir -p "$USERS_DIR"
    chmod 750 "$USERS_DIR"

    if [ ! -f "$ROLES_FILE" ]; then
        cat > "$ROLES_FILE" <<EOF
{
    "admin": {
        "permissions": ["*"],
        "description": "Полный доступ ко всем функциям"
    },
    "developer": {
        "permissions": ["create", "update", "logs", "monitor", "env"],
        "description": "Доступ к разработке и мониторингу"
    },
    "operator": {
        "permissions": ["monitor", "logs", "health", "status"],
        "description": "Доступ к мониторингу и логам"
    }
}
EOF
        chmod 640 "$ROLES_FILE"
    fi
}

handle_user_command() {
    case "$1" in
        create)
            create_user "$2" "$3" "$4"
            ;;
        change-password)
            change_password "$2" "$3" "$4"
            ;;
        deactivate)
            deactivate_user "$2" "$3" "$4"
            ;;
        list)
            list_users "$2" "$3"
            ;;
        show)
            show_user_details "$2"
            ;;
        restore)
            restore_user "$2"
            ;;
        delete)
            delete_user "$2"
            ;;
        *)
            show_user_usage
            return 1
            ;;
    esac
}

create_user() {
    local username="$1"
    local role="$2"
    local password="$3"

    # Validation
    validate_user_input "$username" "$role" "$password" || return 1

    # Create user file
    local password_hash=$(echo "$password" | sha256sum | cut -d' ' -f1)
    create_user_file "$username" "$role" "$password_hash"
}

# Additional user management functions...
