require('dotenv').config();
const { startServer } = require('./src/server/server');
const { startClient } = require('./src/client/client');

// Определяем роль (server или client) через аргументы командной строки
const role = process.argv[2] || 'server';

if (role === 'server') {
    startServer();
} else if (role === 'client') {
    startClient();
} else {
    console.error('Неверная роль. Используйте "server" или "client".');
    process.exit(1);
}
