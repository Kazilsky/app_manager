#!/bin/bash
# components/monitor_manager.sh

source components/config.sh
source components/utils.sh

handle_monitor_command() {
    case "$1" in
        status)
            monitor_app "$2"
            ;;
        logs)
            view_logs "$2" "$3" "$4"
            ;;
        health)
            health_check "$2"
            ;;
        cleanup)
            cleanup "$2"
            ;;
        *)
            show_monitor_usage
            return 1
            ;;
    esac
}

monitor_app() {
    local app_name="$1"

    validate_app_exists "$app_name" || return 1

    echo -e "${YELLOW}=== Monitoring application $app_name ===${NC}"

    # Container status
    echo -e "\n${GREEN}Container Status:${NC}"
    (cd "$APPS_DIR/$app_name" && docker-compose ps)

    # Resource usage
    echo -e "\n${GREEN}Resource Usage:${NC}"
    docker stats --no-stream $(docker-compose -f "$APPS_DIR/$app_name/docker-compose.yml" ps -q)

    # Recent logs
    echo -e "\n${GREEN}Recent Logs:${NC}"
    (cd "$APPS_DIR/$app_name" && docker-compose logs --tail=50)

    # Health check
    check_app_health "$app_name"
}

view_logs() {
    local app_name="$1"
    local service="$2"
    local lines="${3:-100}"

    validate_app_exists "$app_name" || return 1

    if [ -z "$service" ]; then
        (cd "$APPS_DIR/$app_name" && docker-compose logs --tail="$lines" -f)
    else
        (cd "$APPS_DIR/$app_name" && docker-compose logs --tail="$lines" -f "$service")
    fi
}

# Additional monitoring functions...
