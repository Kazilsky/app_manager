# Используем Ubuntu как базовый образ
FROM ubuntu:22.04

# Устанавливаем временную зону
ENV TZ=UTC
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Устанавливаем необходимые пакеты
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    python3-pip \
    redis-server \
    docker.io \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Создаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости Node.js
RUN npm install

# Копируем исходный код
COPY . .

# Создаем директорию для deployments
RUN mkdir -p deployments

# Настраиваем Redis
COPY redis.conf /etc/redis/redis.conf
RUN sed -i 's/bind 127.0.0.1/bind 0.0.0.0/g' /etc/redis/redis.conf

# Устанавливаем переменные окружения
ENV PORT=3000
ENV REDIS_HOST=localhost
ENV REDIS_PORT=6379
ENV DEPLOYMENT_PATH=/app/deployments
ENV MAIN_SERVER_URL=http://localhost:3000
ENV USER=Kazilsky

# Создаем скрипт запуска
RUN echo '#!/bin/bash\n\
service redis-server start\n\
service docker start\n\
node server.js &\n\
node client.js\n\
' > /app/start.sh && chmod +x /app/start.sh

# Открываем порты
EXPOSE 3000 6379

# Запускаем сервисы
CMD ["/app/start.sh"]