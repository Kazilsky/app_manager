#!/bin/bash

# Конфигурация
CONFIG_DIR="/etc/app-manager"
APPS_DIR="/var/www/apps"
HOOKS_DIR="/etc/app-manager/hooks"
APPS_CONFIG_DIR="/etc/app-manager/apps"
TEMPLATES_DIR="/etc/app-manager/templates"
BACKUP_DIR="/var/backups/app-manager"
LOG_DIR="/var/log/app-manager"
LOG_FILE="$LOG_DIR/app-manager.log"
SYSTEMD_DIR="/etc/systemd/system"
NGINX_SITES_DIR="/etc/nginx/sites-available"
NGINX_ENABLED_DIR="/etc/nginx/sites-enabled"

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для проверки и установки пакета
install_package() {
    local package_name="$1"
    if ! command -v "$package_name" &> /dev/null; then
        echo "Установка $package_name..."
        apt-get update && apt-get install -y "$package_name"
    fi
}

# Функция логирования
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Функция для создания необходимых директорий
setup_directories() {
    for dir in "$CONFIG_DIR" "$APPS_DIR" "$HOOKS_DIR" "$APPS_CONFIG_DIR" \
               "$TEMPLATES_DIR" "$BACKUP_DIR" "$LOG_DIR" "$NGINX_SITES_DIR" \
               "$NGINX_ENABLED_DIR"; do
        mkdir -p "$dir"
        chmod 755 "$dir"
    done
}

# Функция определения типа приложения
detect_app_type() {
    local app_dir="$1"

    # Python
    if [ -f "$app_dir/requirements.txt" ] || [ -f "$app_dir/setup.py" ] || [ -f "$app_dir/Pipfile" ]; then
        echo "python"
        return
    fi

    # Node.js
    if [ -f "$app_dir/package.json" ]; then
        echo "nodejs"
        return
    fi

    # PHP
    if [ -f "$app_dir/composer.json" ] || find "$app_dir" -name "*.php" -quit; then
        echo "php"
        return
    fi

    # Go
    if [ -f "$app_dir/go.mod" ] || find "$app_dir" -name "*.go" -quit; then
        echo "golang"
        return
    fi

    # Java/Maven
    if [ -f "$app_dir/pom.xml" ]; then
        echo "java-maven"
        return
    fi

    # Java/Gradle
    if [ -f "$app_dir/build.gradle" ]; then
        echo "java-gradle"
        return
    fi

    # Ruby
    if [ -f "$app_dir/Gemfile" ]; then
        echo "ruby"
        return
    fi

    # Rust
    if [ -f "$app_dir/Cargo.toml" ]; then
        echo "rust"
        return
    fi

    echo "static"
}

# Функция для создания Dockerfile
generate_dockerfile() {
    local app_dir="$1"
    local app_type="$2"

    case "$app_type" in
        "python")
            cat > "$app_dir/Dockerfile" <<EOF
FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "app:app"]
EOF
            ;;

        "nodejs")
            cat > "$app_dir/Dockerfile" <<EOF
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
EOF
            ;;

        "php")
            cat > "$app_dir/Dockerfile" <<EOF
FROM php:8.0-apache
WORKDIR /var/www/html
RUN docker-php-ext-install pdo_mysql
COPY . .
RUN chown -R www-www-data /var/www/html
RUN a2enmod rewrite
EXPOSE 80
CMD ["apache2-foreground"]
EOF
            ;;

        "golang")
            cat > "$app_dir/Dockerfile" <<EOF
FROM golang:1.19-alpine
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN go build -o main .
EXPOSE 8080
CMD ["./main"]
EOF
            ;;

        "java-maven")
            cat > "$app_dir/Dockerfile" <<EOF
FROM maven:3.8-openjdk-17 AS builder
WORKDIR /app
COPY . .
RUN mvn clean package

FROM openjdk:17-slim
COPY --from=builder /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
EOF
            ;;

        "java-gradle")
            cat > "$app_dir/Dockerfile" <<EOF
FROM gradle:7.4-jdk17 AS builder
WORKDIR /app
COPY . .
RUN gradle build

FROM openjdk:17-slim
COPY --from=builder /app/build/libs/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
EOF
            ;;

        "ruby")
            cat > "$app_dir/Dockerfile" <<EOF
FROM ruby:3.0-alpine
WORKDIR /app
COPY Gemfile* ./
RUN bundle install
COPY . .
EXPOSE 3000
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
EOF
            ;;

        "rust")
            cat > "$app_dir/Dockerfile" <<EOF
FROM rust:1.60 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:buster-slim
COPY --from=builder /app/target/release/app /usr/local/bin/
EXPOSE 8080
CMD ["/usr/local/bin/app"]
EOF
            ;;

        "static")
            cat > "$app_dir/Dockerfile" <<EOF
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
EOF
            ;;
    esac
}

# Функция для создания docker-compose.yml
generate_docker_compose() {
    local app_dir="$1"
    local app_name="$2"
    local app_type="$3"

    local default_port
    case "$app_type" in
        "python") default_port=8000 ;;
        "nodejs") default_port=3000 ;;
        "php") default_port=80 ;;
        "golang") default_port=8080 ;;
        "java-maven"|"java-gradle") default_port=8080 ;;
        "ruby") default_port=3000 ;;
        "rust") default_port=8080 ;;
        "static") default_port=80 ;;
    esac

    cat > "$app_dir/docker-compose.yml" <<EOF
version: '3.8'

services:
  app:
    build: .
    container_name: ${app_name}
    restart: unless-stopped
    ports:
      - "${default_port}:${default_port}"
    environment:
      - APP_ENV=production
    volumes:
      - app_/app/data
    networks:
      - app_network
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
EOF

    # Добавляем дополнительные сервисы в зависимости от типа приложения
    case "$app_type" in
        "python"|"nodejs"|"php"|"ruby")
            cat >> "$app_dir/docker-compose.yml" <<EOF

  db:
    image: postgres:13-alpine
    container_name: ${app_name}_db
    restart: unless-stopped
    environment:
      - POSTGRES_DB=${app_name}
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
    volumes:
      - db_/var/lib/postgresql/data
    networks:
      - app_network

  redis:
    image: redis:6-alpine
    container_name: ${app_name}_redis
    restart: unless-stopped
    volumes:
      - redis_data:/data
    networks:
      - app_network

  nginx:
    image: nginx:alpine
    container_name: ${app_name}_nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - app
    networks:
      - app_network

networks:
  app_network:
    driver: bridge

volumes:
  app_
  db_
  redis_
EOF
            ;;
        *)
            cat >> "$app_dir/docker-compose.yml" <<EOF

networks:
  app_network:
    driver: bridge

volumes:
  app_data:
EOF
            ;;
    esac
}

# Функция для генерации nginx конфигурации
generate_nginx_config() {
    local app_name="$1"
    local domain="$2"
    local port="$3"

    cat > "$NGINX_SITES_DIR/$app_name.conf" <<EOF
server {
    listen 80;
    server_name ${domain};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/nginx/ssl/${domain}.crt;
    ssl_certificate_key /etc/nginx/ssl/${domain}.key;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000" always;

    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self' http: https:  blob: 'unsafe-inline'" always;
}
EOF

    ln -sf "$NGINX_SITES_DIR/$app_name.conf" "$NGINX_ENABLED_DIR/$app_name.conf"
}

# Функция для создания SSL сертификата
generate_ssl_cert() {
    local domain="$1"
    local ssl_dir="/etc/nginx/ssl"

    mkdir -p "$ssl_dir"

    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$ssl_dir/$domain.key" \
        -out "$ssl_dir/$domain.crt" \
        -subj "/C=US/ST=State/L=City/O=Organization/CN=$domain"
}

# Функция для создания резервной копии
backup_app() {
    local app_name="$1"
    local backup_date=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/${app_name}_${backup_date}.tar.gz"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    # Останавливаем контейнеры
    (cd "$APPS_DIR/$app_name" && docker-compose down)

    # Создаем резервную копию
    tar -czf "$backup_file" -C "$APPS_DIR" "$app_name"

    # Экспортируем данные базы данных, если она есть
    if [ -f "$APPS_DIR/$app_name/docker-compose.yml" ] && grep -q "db:" "$APPS_DIR/$app_name/docker-compose.yml"; then
        docker-compose -f "$APPS_DIR/$app_name/docker-compose.yml" exec db \
            pg_dump -U postgres "$app_name" > "$BACKUP_DIR/${app_name}_${backup_date}_db.sql"
    fi

    # Запускаем контейнеры обратно
    (cd "$APPS_DIR/$app_name" && docker-compose up -d)

    log "Создана резервная копия $app_name: $backup_file"
}

# Функция для восстановления из резервной копии
restore_app() {
    local app_name="$1"
    local backup_file="$2"

    if [ ! -f "$backup_file" ]; then
        echo "Файл резервной копии не найден: $backup_file"
        return 1
    fi

    # Останавливаем и удаляем текущее приложение, если оно существует
    if [ -d "$APPS_DIR/$app_name" ]; then
        (cd "$APPS_DIR/$app_name" && docker-compose down -v)
        rm -rf "$APPS_DIR/$app_name"
    fi

    # Восстанавливаем файлы
    tar -xzf "$backup_file" -C "$APPS_DIR"

    # Восстанавливаем базу данных, если есть дамп
    local db_backup="${backup_file%.*}_db.sql"
    if [ -f "$db_backup" ] && [ -f "$APPS_DIR/$app_name/docker-compose.yml" ]; then
        (cd "$APPS_DIR/$app_name" && docker-compose up -d db)
        sleep 10  # Даем базе данных время для запуска
        docker-compose -f "$APPS_DIR/$app_name/docker-compose.yml" exec -T db \
            psql -U postgres -d "$app_name" < "$db_backup"
    fi

    # Запускаем приложение
    (cd "$APPS_DIR/$app_name" && docker-compose up -d)

    log "Приложение $app_name восстановлено из $backup_file"
}

# Функция для мониторинга приложения
monitor_app() {
    local app_name="$1"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    echo -e "${YELLOW}=== Мониторинг приложения $app_name ===${NC}"

    # Статус контейнеров
    echo -e "\n${GREEN}Статус контейнеров:${NC}"
    (cd "$APPS_DIR/$app_name" && docker-compose ps)

    # Использование ресурсов
    echo -e "\n${GREEN}Использование ресурсов:${NC}"
    docker stats --no-stream $(docker-compose -f "$APPS_DIR/$app_name/docker-compose.yml" ps -q)

    # Последние логи
    echo -e "\n${GREEN}Последние логи:${NC}"
    (cd "$APPS_DIR/$app_name" && docker-compose logs --tail=50)

    # Проверка доступности
    local config_file="$APPS_CONFIG_DIR/${app_name}.conf"
    if [ -f "$config_file" ]; then
        source "$config_file"
        local status_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT:-80}")
        echo -e "\n${GREEN}Статус HTTP: ${status_code}${NC}"
    fi
}

# Функция для просмотра логов
view_logs() {
    local app_name="$1"
    local service="$2"
    local lines="${3:-100}"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    if [ -z "$service" ]; then
        (cd "$APPS_DIR/$app_name" && docker-compose logs --tail="$lines" -f)
    else
        (cd "$APPS_DIR/$app_name" && docker-compose logs --tail="$lines" -f "$service")
    fi
}

# Функция для обновления приложения
update_app() {
    local app_name="$1"
    local branch="${2:-main}"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    # Создаем резервную копию перед обновлением
    backup_app "$app_name"

    # Обновляем код из репозитория
    (cd "$APPS_DIR/$app_name" && git fetch && git checkout "$branch" && git pull)

    # Перезапускаем контейнеры с пересборкой
    (cd "$APPS_DIR/$app_name" && docker-compose down && docker-compose build --no-cache && docker-compose up -d)

    log "Приложение $app_name обновлено до последней версии ветки $branch"
}

# Функция для масштабирования приложения
scale_app() {
    local app_name="$1"
    local service="$2"
    local replicas="$3"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    (cd "$APPS_DIR/$app_name" && docker-compose up -d --scale "$service=$replicas")
    log "Сервис $service приложения $app_name масштабирован до $replicas реплик"
}

# Функция для проверки здоровья приложения
health_check() {
    local app_name="$1"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    echo -e "${YELLOW}=== Проверка здоровья $app_name ===${NC}"

    # Проверяем статус контейнеров
    local containers=$(docker-compose -f "$APPS_DIR/$app_name/docker-compose.yml" ps -q)
    for container in $containers; do
        local status=$(docker inspect --format='{{.State.Status}}' "$container")
        local name=$(docker inspect --format='{{.Name}}' "$container")
        echo -e "Контейнер ${name#/}: ${GREEN}$status${NC}"
    done

    # Проверяем использование диска
    echo -e "\n${GREEN}Использование диска:${NC}"
    docker system df | grep "$app_name"

    # Проверяем свободное место
    echo -e "\n${GREEN}Свободное место на диске:${NC}"
    df -h "$APPS_DIR/$app_name"
}

# Функция для очистки
cleanup() {
    local app_name="$1"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    echo "Очистка неиспользуемых ресурсов для $app_name..."

    # Удаляем неиспользуемые образы
    docker image prune -af --filter "label=com.docker.compose.project=$app_name"

    # Удаляем неиспользуемые volumes
    docker volume prune -f

    # Очистка логов
    local log_files=("$LOG_DIR/${app_name}"*)
    if [ ${#log_files[@]} -gt 0 ]; then
        find "$LOG_DIR" -name "${app_name}*" -type f -mtime +7 -delete
    fi

    # Очистка старых резервных копий
    local backup_files=("$BACKUP_DIR/${app_name}"*)
    if [ ${#backup_files[@]} -gt 0 ]; then
        find "$BACKUP_DIR" -name "${app_name}*" -type f -mtime +30 -delete
    fi

    log "Выполнена очистка для $app_name"
}

# Функция для установки SSL сертификата Let's Encrypt
setup_ssl() {
    local app_name="$1"
    local domain="$2"

    if [ ! -d "$APPS_DIR/$app_name" ]; then
        echo "Приложение $app_name не найдено"
        return 1
    fi

    # Устанавливаем certbot
    install_package "certbot"
    install_package "python3-certbot-nginx"

    # Получаем сертификат
    certbot --nginx -d "$domain" --non-interactive --agree-tos --email "admin@${domain}" --redirect

    log "SSL сертификат установлен для $domain"
}

# Функция для управления переменными окружения
manage_env() {
    local app_name="$1"
    local action="$2"
    local key="$3"
    local value="$4"

    local env_file="$APPS_DIR/$app_name/.env"

    case "$action" in
        "set")
            if [ -z "$key" ] || [ -z "$value" ]; then
                echo "Использование: app env set <имя_приложения> <ключ> <значение>"
                return 1
            fi
            # Обновляем или добавляем переменную
            if grep -q "^${key}=" "$env_file" 2>/dev/null; then
                sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
            else
                echo "${key}=${value}" >> "$env_file"
            fi
            ;;

        "get")
            if [ -z "$key" ]; then
                echo "Использование: app env get <имя_приложения> <ключ>"
                return 1
            fi
            grep "^${key}=" "$env_file" 2>/dev/null
            ;;

        "list")
            if [ -f "$env_file" ]; then
                cat "$env_file"
            else
                echo "Файл .env не найден"
            fi
            ;;

        "delete")
            if [ -z "$key" ]; then
                echo "Использование: app env delete <имя_приложения> <ключ>"
                return 1
            fi
            sed -i "/^${key}=/d" "$env_file"
            ;;

        *)
            echo "Неизвестное действие: $action"
            echo "Доступные действия: set, get, list, delete"
            return 1
            ;;
    esac

    # Перезапускаем приложение для применения изменений
    (cd "$APPS_DIR/$app_name" && docker-compose up -d)
}

# Основной обработчик команд
case "$1" in
    create)
        create_app "$2" "$3" "$4"
        ;;
    delete)
        delete_app "$2"
        ;;
    enable)
        enable_app "$2"
        ;;
    disable)
        disable_app "$2"
        ;;
    status)
        status_app "$2"
        ;;
    install)
        install_dependencies
        ;;
    backup)
        backup_app "$2"
        ;;
    restore)
        restore_app "$2" "$3"
        ;;
    monitor)
        monitor_app "$2"
        ;;
    logs)
        view_logs "$2" "$3" "$4"
        ;;
    update)
        update_app "$2" "$3"
        ;;
    scale)
        scale_app "$2" "$3" "$4"
        ;;
    health)
        health_check "$2"
        ;;
    cleanup)
        cleanup "$2"
        ;;
    ssl)
        setup_ssl "$2" "$3"
        ;;
    env)
        manage_env "$2" "$3" "$4" "$5"
        ;;
    *)
        echo -e "${YELLOW}Использование:${NC}"
        echo "  app install                      - Установка зависимостей и настройка сервиса"
        echo "  app create <имя> <репозиторий> [ветка] - Создание нового приложения"
        echo "  app delete <имя>                 - Удаление приложения"
        echo "  app enable <имя>                 - Включение приложения"
        echo "  app disable <имя>                - Отключение приложения"
        echo "  app status <имя>                 - Статус приложения"
        echo "  app backup <имя>                 - Создание резервной копии"
        echo "  app restore <имя> <файл>         - Восстановление из резервной копии"
        echo "  app monitor <имя>                - Мониторинг приложения"
        echo "  app logs <имя> [сервис] [строки] - Просмотр логов"
        echo "  app update <имя> [ветка]         - Обновление приложения"
        echo "  app scale <имя> <сервис> <число> - Масштабирование сервиса"
        echo "  app health <имя>                 - Проверка здоровья приложения"
        echo "  app cleanup <имя>                - Очистка неиспользуемых ресурсов"
        echo "  app ssl <имя> <домен>            - Установка SSL сертификата"
        echo "  app env <имя> <действие> [ключ] [значение] - Управление переменными окружения"
        ;;
esac