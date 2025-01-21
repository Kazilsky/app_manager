from flask import Flask, request, jsonify
import subprocess
import logging
import os
from datetime import datetime

app = Flask(__name__)

# Настройка логирования
def setup_logging():
    # Создаем директорию для логов если её нет
    log_dir = "logs"
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)

    # Имя файла лога с текущей датой
    log_file = os.path.join(log_dir, f"webhook_{datetime.now().strftime('%Y%m%d')}.log")

    # Настройка форматирования
    formatter = logging.Formatter(
        '%(asctime)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # Настройка файлового обработчика
    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(formatter)

    # Настройка консольного обработчика
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    # Настройка логгера
    logger = logging.getLogger('webhook')
    logger.setLevel(logging.INFO)
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger

logger = setup_logging()

@app.route('/webhook', methods=['POST'])
def webhook():
    try:
        # Логируем начало обработки запроса
        logger.info("Получен новый webhook запрос")

        # Получаем данные из запроса
        data = request.json
        if not data:
            logger.error("Получены невалидные JSON данные")
            return jsonify({"error": "Invalid JSON data"}), 400

        # Логируем полученные данные (без sensitive информации)
        logger.info(f"Получены данные: username={data.get('owner', {}).get('name')}, "
                   f"app_name={data.get('repository', {}).get('name')}, action={'pull'}, json={data}")

        username = data.get('repository', {}).get('owner', {}).get('name')
        app_name = data.get('repository', {}).get('name')
        action = 'pull'

        if not all([username, app_name, action]):
            missing_params = [param for param, value in {
                'username': username,
                'app_name': app_name,
                'action': action
            }.items() if not value]

            logger.error(f"Отсутствуют обязательные параметры: {', '.join(missing_params)}")
            return jsonify({"error": "Missing parameters"}), 400

        # Логируем выполнение команды
        logger.info(f"Выполняется команда для приложения {app_name} пользователя {username}")

        # Выполняем команду bash-скрипта
        result = subprocess.run(
            ['bash', '../app.bash', 'webhook', username, app_name, action],
            capture_output=True,
            text=True
        )

        # Логируем результат выполнения
        if result.returncode == 0:
            logger.info(f"Команда успешно выполнена: {result.stdout.strip()}")
            return jsonify({"message": result.stdout.strip()}), 200
        else:
            logger.error(f"Ошибка выполнения команды: {result.stderr.strip()}")
            return jsonify({"error": result.stderr.strip()}), 500

    except Exception as e:
        # Логируем любые необработанные исключения
        logger.exception(f"Необработанная ошибка: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/')
def index():
    logger.info("Запрос к корневому маршруту")
    return "App Manager Webhook Service is running."

@app.before_request
def log_request_info():
    """Логирование информации о каждом запросе"""
    logger.info(f"Получен {request.method} запрос к {request.path} от {request.remote_addr}")

@app.after_request
def log_response_info(response):
    """Логирование информации о каждом ответе"""
    logger.info(f"Отправлен ответ со статусом {response.status}")
    return response

if __name__ == '__main__':
    logger.info("Запуск сервера webhook")
    app.run(host='0.0.0.0', port=5000)