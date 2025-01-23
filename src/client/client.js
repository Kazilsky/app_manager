const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const SSHFS_MOUNT = '/mnt/shared'; // Локальная папка для общей файловой системы
const MAIN_SERVER_USER = 'user'; // Имя пользователя для SSH
const MAIN_SERVER_HOST = 'localhost'; // IP-адрес основного сервера
const MAIN_SERVER_PATH = '/srv/shared'; // Путь на основном сервере

function mountSharedFolder() {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(SSHFS_MOUNT)) {
            fs.mkdirSync(SSHFS_MOUNT, { recursive: true }); // Создаём папку, если её нет
        }

        // Проверяем, смонтирована ли уже папка
        exec(`mount | grep ${SSHFS_MOUNT}`, (err, stdout) => {
            if (stdout.includes(SSHFS_MOUNT)) {
                console.log('Папка уже смонтирована');
                resolve();
            } else {
                console.log('Монтируем SSHFS...');
                const sshfsCommand = `sshfs ${MAIN_SERVER_USER}@${MAIN_SERVER_HOST}:${MAIN_SERVER_PATH} ${SSHFS_MOUNT}`;
                exec(sshfsCommand, (err) => {
                    if (err) {
                        console.error('Ошибка монтирования SSHFS:', err);
                        reject(err);
                    } else {
                        console.log('SSHFS успешно смонтирован');
                        resolve();
                    }
                });
            }
        });
    });
}

// Пример использования в основной логике
(async () => {
    try {
        await mountSharedFolder();

        // Деплой проекта после монтирования
        const projectPath = path.join(SSHFS_MOUNT, 'my-project');
        const gitRepo = 'https://github.com/your/repo.git';

        exec(`git clone ${gitRepo} ${projectPath}`, (err) => {
            if (err) {
                console.error('Ошибка скачивания проекта:', err);
            } else {
                console.log(`Проект успешно скачан в ${projectPath}`);
            }
        });
    } catch (err) {
        console.error('Ошибка работы с SSHFS:', err);
    }
})();
