const io = require('socket.io-client');
const os = require('os');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

class WorkerNode {
    constructor(mainServerUrl) {
        this.mainServerUrl = mainServerUrl;
        this.workerId = null;
        this.deploymentPath = process.env.DEPLOYMENT_PATH || './deployments';
        this.currentUser = 'Kazilsky';
        this.startTime = '2025-01-23 19:26:36';
        this.ensureDeploymentPath();

        this.socket = io(mainServerUrl, {
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.workerConfig = {
            hostname: os.hostname(),
            startTime: this.startTime,
            currentUser: this.currentUser
        };

        console.log(`[${this.startTime}] Worker Config:`, this.workerConfig);

        this.initializeSocketHandlers();
        this.startResourceCleaning();
    }

    ensureDeploymentPath() {
        if (!fs.existsSync(this.deploymentPath)) {
            fs.mkdirSync(this.deploymentPath, { recursive: true });
        }
    }

    formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }

        return `${value.toFixed(2)} ${units[unitIndex]}`;
    }

    getCurrentTimestamp() {
        return new Date().toISOString().replace('T', ' ').slice(0, 19);
    }

    initializeSocketHandlers() {
        this.socket.on('connect', () => {
            console.log(`[${this.getCurrentTimestamp()}] Connected to main server, registering...`);
            this.socket.emit('registerWorker', this.workerConfig);
        });

        this.socket.on('disconnect', () => {
            console.log(`[${this.getCurrentTimestamp()}] Disconnected from main server`);
        });

        this.socket.on('workerRegistered', (data) => {
            console.log(`[${this.getCurrentTimestamp()}] Worker Registered:`, data);
            this.workerId = data.id;
            this.startStatusReporting();
        });

        this.socket.on('deployRepository', async (deploymentData) => {
            console.log(`[${this.getCurrentTimestamp()}] Deploy Command Received:`, deploymentData);
            await this.deployProject(deploymentData);
        });

        this.socket.on('removeReplica', async (data) => {
            try {
                const { deploymentId, replicaId } = data;
                console.log(`[${this.getCurrentTimestamp()}] Removing replica ${replicaId} for deployment ${deploymentId}`);

                const deploymentDir = path.join(this.deploymentPath, `${deploymentId}_${replicaId}`);
                await this.cleanup(deploymentDir, deploymentId, replicaId);

                this.socket.emit('replicaRemoved', {
                    workerId: this.workerId,
                    deploymentId,
                    replicaId,
                    timestamp: this.getCurrentTimestamp()
                });
            } catch (error) {
                console.error('Error removing replica:', error);
            }
        });

        this.socket.on('error', (err) => {
            console.error(`[${this.getCurrentTimestamp()}] Socket Error:`, err);
        });
    }

    async getRunningContainers() {
        try {
            const { stdout, stderr } = await execPromise('docker ps -q | wc -l');
            if (stderr) {
                console.error('Docker command stderr:', stderr);
                return 0;
            }
            return parseInt(stdout.toString().trim()) || 0;
        } catch (error) {
            console.error('Error getting running containers:', error);
            return 0;
        }
    }

    getMemoryUsage() {
        try {
            const total = os.totalmem();
            const free = os.freemem();
            const used = total - free;

            const dockerStats = execSync('docker stats --no-stream --format "{{.MemPerc}}"')
                .toString()
                .split('\n')
                .filter(Boolean)
                .map(stat => parseFloat(stat.replace('%', '')));

            const dockerMemoryUsage = dockerStats.length > 0
                ? dockerStats.reduce((a, b) => a + b, 0) / dockerStats.length
                : 0;

            const systemMemoryUsage = (used / total) * 100;
            const actualMemoryUsage = Math.max(systemMemoryUsage, dockerMemoryUsage);

            console.log(`[${this.getCurrentTimestamp()}] Memory Usage:`, {
                total: this.formatBytes(total),
                free: this.formatBytes(free),
                used: this.formatBytes(used),
                systemPercentage: systemMemoryUsage.toFixed(2) + '%',
                dockerPercentage: dockerMemoryUsage.toFixed(2) + '%',
                actualPercentage: actualMemoryUsage.toFixed(2) + '%'
            });

            return actualMemoryUsage;
        } catch (error) {
            console.error('Error calculating memory usage:', error);
            return 0;
        }
    }

    async calculateStatus(loadAvg) {
        try {
            const runningContainers = await this.getRunningContainers();
            const memoryUsage = this.getMemoryUsage();
            const cpuUsage = parseFloat(loadAvg[0].toFixed(2));

            const dockerStats = execSync('docker stats --no-stream --format "{{.CPUPerc}}"')
                .toString()
                .split('\n')
                .filter(Boolean)
                .map(stat => parseFloat(stat.replace('%', '')));

            const dockerCpuUsage = dockerStats.length > 0
                ? dockerStats.reduce((a, b) => a + b, 0) / dockerStats.length
                : 0;

            let status = 'active';
            const maxCpuUsage = Math.max(cpuUsage, dockerCpuUsage);

            if (maxCpuUsage > 80 || memoryUsage > 90) {
                status = 'overloaded';
            } else if (maxCpuUsage > 60 || memoryUsage > 70) {
                status = 'busy';
            }

            return {
                workerId: this.workerId,
                status: status,
                load: {
                    cpuUsage: maxCpuUsage,
                    memoryUsage: parseFloat(memoryUsage.toFixed(2)),
                    runningContainers: runningContainers,
                    dockerStats: {
                        cpu: dockerCpuUsage.toFixed(2) + '%',
                        memory: memoryUsage.toFixed(2) + '%'
                    }
                },
                timestamp: this.getCurrentTimestamp()
            };
        } catch (error) {
            console.error('Error calculating status:', error);
            return {
                workerId: this.workerId,
                status: 'active',
                load: {
                    cpuUsage: 0,
                    memoryUsage: 0,
                    runningContainers: 0
                },
                timestamp: this.getCurrentTimestamp()
            };
        }
    }

    startStatusReporting() {
        setInterval(async () => {
            try {
                const loadAvg = os.loadavg();
                const status = await this.calculateStatus(loadAvg);
                console.log(`[${this.getCurrentTimestamp()}] Reporting status:`, status);
                this.socket.emit('workerStatus', status);
            } catch (error) {
                console.error('Error in status reporting:', error);
            }
        }, 15000);
    }

    startResourceCleaning() {
        setInterval(async () => {
            try {
                await execPromise('docker system prune -f').catch(() => {});

                if (global.gc) {
                    global.gc();
                }

                const memUsage = process.memoryUsage();
                console.log(`[${this.getCurrentTimestamp()}] Memory cleanup:`, {
                    heapUsed: this.formatBytes(memUsage.heapUsed),
                    heapTotal: this.formatBytes(memUsage.heapTotal),
                    rss: this.formatBytes(memUsage.rss),
                    external: this.formatBytes(memUsage.external)
                });
            } catch (error) {
                console.error('Error in resource cleaning:', error);
            }
        }, 5 * 60 * 1000);
    }

    async createDockerfile(deploymentDir) {
        const dockerfileContent = `FROM python:3.9-slim-buster
WORKDIR /app

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
    gcc \\
    python3-dev \\
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt || \\
    pip install --no-cache-dir fastapi uvicorn

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`;

        const dockerignore = `
__pycache__
*.pyc
*.pyo
*.pyd
.Python
env/
venv/
.env
.venv
pip-log.txt
*.log
.git
.gitignore
.pytest_cache
.coverage
htmlcov/
build/
dist/
*.egg-info/
.idea/
.vscode/`;

        await fs.promises.writeFile(`${deploymentDir}/Dockerfile`, dockerfileContent);
        await fs.promises.writeFile(`${deploymentDir}/.dockerignore`, dockerignore);

        console.log(`[${this.getCurrentTimestamp()}] Created Dockerfile and .dockerignore`);
    }

    async retryDockerBuild(deploymentDir, deploymentId, replicaId, maxAttempts = 3) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[${this.getCurrentTimestamp()}] Docker build attempt ${attempt}/${maxAttempts}`);

                await execPromise('docker system prune -f').catch(() => {});

                const buildCommand = `cd ${deploymentDir} && DOCKER_BUILDKIT=1 docker build \
                    --network=host \
                    --progress=plain \
                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                    -t app-${deploymentId}:${replicaId} .`;

                const { stdout } = await execPromise(buildCommand);
                console.log('Build output:', stdout);
                return true;
            } catch (error) {
                console.error(`Build attempt ${attempt} failed:`, error.message);

                if (attempt === maxAttempts) {
                    throw new Error(`Failed to build after ${maxAttempts} attempts: ${error.message}`);
                }

                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        return false;
    }

    async deployProject(deploymentData) {
        const { deploymentDir, repoUrl, replicaId, deploymentId } = deploymentData;
        console.log(`[${this.getCurrentTimestamp()}] Starting deployment:`, deploymentData);

        try {
            const normalizedUrl = repoUrl
                .replace(/^(https:\/\/github\.com\/)+/, '')
                .replace(/\.git$/, '')
                .replace(/^https:\/\/github\.com\//, '');

            await this.cleanup(deploymentDir, deploymentId, replicaId);

            console.log(`[${this.getCurrentTimestamp()}] Cloning repository:`, normalizedUrl);
            const cloneCommand = `git clone --depth 1 https://github.com/${normalizedUrl}.git ${deploymentDir}`;
            await execPromise(cloneCommand);

            const hasRequirements = fs.existsSync(`${deploymentDir}/requirements.txt`);
            if (!hasRequirements) {
                await fs.promises.writeFile(
                    `${deploymentDir}/requirements.txt`,
                    'fastapi\nuvicorn\n'
                );
            }

            await this.createDockerfile(deploymentDir);
            await this.retryDockerBuild(deploymentDir, deploymentId, replicaId);

            const port = 8000 + parseInt(replicaId);

            await execPromise(`docker stop app-${deploymentId}-${replicaId}`).catch(() => {});
            await execPromise(`docker rm app-${deploymentId}-${replicaId}`).catch(() => {});

            console.log(`[${this.getCurrentTimestamp()}] Starting container on port ${port}`);
            const runCommand = `docker run -d \
                --name app-${deploymentId}-${replicaId} \
                --network host \
                -e PORT=${port} \
                --restart unless-stopped \
                --memory="512m" \
                --memory-swap="1g" \
                --cpu-shares=1024 \
                --cpus=1 \
                app-${deploymentId}:${replicaId}`;

            await execPromise(runCommand);

            const containerStatus = await execPromise(
                `docker ps -f name=app-${deploymentId}-${replicaId} --format "{{.Status}}"`
            );
            console.log('Container status:', containerStatus.stdout);

            this.socket.emit('deploymentStatus', {
                workerId: this.workerId,
                replicaId: replicaId,
                status: 'active',
                port: port,
                deploymentId: deploymentId,
                timestamp: this.getCurrentTimestamp(),
                metrics: {
                    cpuUsage: 0,
                    memoryUsage: 0
                }
            });

        } catch (error) {
            console.error('Deployment error:', error);

            this.socket.emit('deploymentStatus', {
                workerId: this.workerId,
                replicaId: replicaId,
                status: 'failed',
                error: error.message,
                deploymentId: deploymentId,
                timestamp: this.getCurrentTimestamp()
            });

            await this.cleanup(deploymentDir, deploymentId, replicaId);
        }
    }

    async cleanup(deploymentDir, deploymentId, replicaId) {
        try {
            console.log(`[${this.getCurrentTimestamp()}] Starting cleanup for ${deploymentId}-${replicaId}`);

            const containerInfo = await execPromise(`docker inspect app-${deploymentId}-${replicaId}`).catch(() => null);

            if (containerInfo) {
                console.log('Container info before cleanup:', JSON.parse(containerInfo.stdout)[0]);
            }

            await execPromise(`docker stop -t 10 app-${deploymentId}-${replicaId}`).catch(() => {});
            await execPromise(`docker rm -f -v app-${deploymentId}-${replicaId}`).catch(() => {});
            await execPromise(`docker rmi -f app-${deploymentId}:${replicaId}`).catch(() => {});
            await execPromise('docker system prune -f').catch(() => {});

            if (fs.existsSync(deploymentDir)) {
                await fs.promises.rm(deploymentDir, { recursive: true, force: true });
            }

            console.log(`[2025-01-23 19:28:25] Cleanup completed for ${deploymentId}-${replicaId}`);

            if (global.gc) {
                global.gc();
            }
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
}

// Initialize worker with current time and user
const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || 'http://localhost:3000';
console.log(`[2025-01-23 19:28:25] Starting worker node for user: Kazilsky`);
const worker = new WorkerNode(MAIN_SERVER_URL);

// Handle process termination
process.on('SIGTERM', async () => {
    console.log(`[2025-01-23 19:28:25] Received SIGTERM. Cleaning up...`);
    if (worker.socket) {
        worker.socket.close();
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log(`[2025-01-23 19:28:25] Received SIGINT. Cleaning up...`);
    if (worker.socket) {
        worker.socket.close();
    }
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error(`[2025-01-23 19:28:25] Uncaught Exception:`, error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[2025-01-23 19:28:25] Unhandled Rejection at:`, promise, 'reason:', reason);
});

// Export worker for testing
module.exports = WorkerNode;