const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let workers = []; // Список дочерних серверов

// Помощник для выбора наименее загруженного сервера
function getLeastLoadedWorker() {
    if (workers.length === 0) return null;
    return workers.reduce((prev, curr) => (prev.load < curr.load ? prev : curr));
}

// Маршрут для деплоя проекта
app.post('/deploy', (req, res) => {
    const { projectName, gitRepo, replicas } = req.body;

    // Найти наименее загруженный сервер
    const worker = getLeastLoadedWorker();
    if (!worker) return res.status(500).send('Нет доступных дочерних серверов');

    // Команда для дочернего сервера
    const command = {
        action: 'deploy',
        project: projectName,
        gitRepo,
        replicas,
    };

    worker.connection.send(JSON.stringify(command)); // Отправляем команду
    worker.load += replicas; // Увеличиваем нагрузку

    res.send(`Проект "${projectName}" отправлен на сервер ${worker.id}`);
});

// Обработка подключений дочерних серверов
wss.on('connection', (ws) => {
    console.log('Дочерний сервер подключён');

    const worker = { id: Date.now(), connection: ws, load: 0 }; // Идентификатор и статус
    workers.push(worker);

    ws.on('message', (message) => {
        console.log(`Сообщение от дочернего сервера: ${message}`);
    });

    ws.on('close', () => {
        workers = workers.filter((w) => w.connection !== ws); // Удаляем отключённый сервер
        console.log('Дочерний сервер отключился');
    });
});

// Запуск основного сервера
server.listen(3000, () => {
    console.log('Основной сервер запущен на порту 3000');
});
