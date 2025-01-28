const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const axios = require('axios');
const fs = require('fs');

// Redis connection
const redis = new Redis({
    port: 6379,
    host: 'localhost',
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

class DeploymentOrchestrator {
    constructor() {
        this.io = null;
        this.redis = redis;
        this.deploymentPath = process.env.DEPLOYMENT_PATH || './deployments';
        this.ensureDeploymentPath();

        // Constants
        this.KEYS = {
            WORKER: 'worker:',
            DEPLOYMENT: 'deployment:',
            REPLICA: 'replica:',
            COUNTER: 'counter:',
            SET: {
                WORKERS: 'workers',
                DEPLOYMENTS: 'deployments',
                REPLICAS: 'replicas'
            }
        };

        // Intervals and timeouts
        this.cleanupInterval = 60 * 1000; // 1 minute
        this.inactiveTimeout = 2 * 60 * 1000; // 2 minutes

        // Scaling settings
        this.scalingSettings = {
            cpuThreshold: 70,
            checkInterval: 30000,
            scaleUpCooldown: 300000,
            scaleDownCooldown: 600000
        };

        this.startScalingMonitor();
    }

    ensureDeploymentPath() {
        if (!fs.existsSync(this.deploymentPath)) {
            fs.mkdirSync(this.deploymentPath, { recursive: true });
        }
    }

    async getNextId(type) {
        return await this.redis.incr(`${this.KEYS.COUNTER}${type}`);
    }

    async startScalingMonitor() {
        setInterval(async () => {
            try {
                const deploymentIds = await this.redis.smembers(this.KEYS.SET.DEPLOYMENTS);
                for (const deploymentId of deploymentIds) {
                    const deployment = await this.getDeployment(deploymentId);
                    if (deployment && deployment.status === 'active') {
                        await this.checkAndScale(deployment);
                    }
                }
            } catch (error) {
                console.error('Error in scaling monitor:', error);
            }
        }, this.scalingSettings.checkInterval);
    }

    async getDeployment(deploymentId) {
        const data = await this.redis.get(`${this.KEYS.DEPLOYMENT}${deploymentId}`);
        return data ? JSON.parse(data) : null;
    }

    async checkAndScale(deployment) {
        try {
            const replicaIds = await this.redis.smembers(
                `${this.KEYS.DEPLOYMENT}${deployment.id}:replicas`
            );
            const replicas = await Promise.all(
                replicaIds.map(id => this.redis.get(`${this.KEYS.REPLICA}${id}`))
            );

            const activeReplicas = replicas
                .map(r => JSON.parse(r))
                .filter(r => r.status === 'active');

            let totalCpuLoad = 0;
            activeReplicas.forEach(replica => {
                totalCpuLoad += replica.metrics?.cpuUsage || 0;
            });

            const avgCpuLoad = activeReplicas.length > 0 ?
                totalCpuLoad / activeReplicas.length : 0;

            console.log(`[${new Date().toISOString()}] Deployment ${deployment.id} - Average CPU Load: ${avgCpuLoad}%`);

            const now = Date.now();
            if (avgCpuLoad > this.scalingSettings.cpuThreshold &&
                replicas.length < deployment.maxReplicas &&
                (!deployment.lastScaleUp ||
                    (now - deployment.lastScaleUp > this.scalingSettings.scaleUpCooldown))) {
                await this.scaleUp(deployment);
            } else if (avgCpuLoad < this.scalingSettings.cpuThreshold / 2 &&
                replicas.length > deployment.minReplicas &&
                (!deployment.lastScaleDown ||
                    (now - deployment.lastScaleDown > this.scalingSettings.scaleDownCooldown))) {
                await this.scaleDown(deployment);
            }
        } catch (error) {
            console.error(`Error checking scaling for deployment ${deployment.id}:`, error);
        }
    }

    async findAvailableWorker() {
        const workers = await this.redis.smembers(this.KEYS.SET.WORKERS);
        for (const workerId of workers) {
            const workerData = await this.redis.get(`${this.KEYS.WORKER}${workerId}`);
            if (workerData) {
                const worker = JSON.parse(workerData);
                if (worker.status === 'active' && worker.currentLoad.cpuUsage < 80) {
                    return worker;
                }
            }
        }
        return null;
    }

    async scaleUp(deployment) {
        try {
            console.log(`[${new Date().toISOString()}] Scaling up deployment ${deployment.id}`);

            const worker = await this.findAvailableWorker();
            if (!worker) {
                throw new Error('No available workers found');
            }

            const replicaId = await this.getNextId('replica');
            const replica = {
                id: replicaId,
                deploymentId: deployment.id,
                status: 'pending',
                replicaNumber: deployment.workers.length + 1
            };

            await this.redis.set(
                `${this.KEYS.REPLICA}${replicaId}`,
                JSON.stringify(replica)
            );
            await this.redis.sadd(
                `${this.KEYS.DEPLOYMENT}${deployment.id}:replicas`,
                replicaId
            );

            deployment.lastScaleUp = Date.now();
            deployment.workers.push({
                workerId: worker.id,
                replicaId: replica.replicaNumber,
                status: 'pending'
            });

            await this.redis.set(
                `${this.KEYS.DEPLOYMENT}${deployment.id}`,
                JSON.stringify(deployment)
            );

            this.io.to(worker.socketId).emit('deploymentTask', {
                deploymentId: deployment.id,
                replicaId: replica.replicaNumber,
                githubRepo: deployment.githubRepo,
                deploymentTime: new Date().toISOString()
            });

        } catch (error) {
            console.error(`Error scaling up deployment ${deployment.id}:`, error);
        }
    }

    async scaleDown(deployment) {
        try {
            console.log(`[${new Date().toISOString()}] Scaling down deployment ${deployment.id}`);

            const lastWorker = deployment.workers[deployment.workers.length - 1];
            if (!lastWorker) return;

            const workerData = await this.redis.get(`${this.KEYS.WORKER}${lastWorker.workerId}`);
            if (!workerData) return;
            const worker = JSON.parse(workerData);

            this.io.to(worker.socketId).emit('removeReplica', {
                deploymentId: deployment.id,
                replicaId: lastWorker.replicaId
            });

            deployment.lastScaleDown = Date.now();
            deployment.workers.pop();
            await this.redis.set(
                `${this.KEYS.DEPLOYMENT}${deployment.id}`,
                JSON.stringify(deployment)
            );

            await this.redis.srem(
                `${this.KEYS.DEPLOYMENT}${deployment.id}:replicas`,
                lastWorker.replicaId
            );
            await this.redis.del(`${this.KEYS.REPLICA}${lastWorker.replicaId}`);

        } catch (error) {
            console.error(`Error scaling down deployment ${deployment.id}:`, error);
        }
    }

    async cleanupInactiveWorkers() {
        try {
            const workers = await this.redis.smembers(this.KEYS.SET.WORKERS);
            const cutoffTime = Date.now() - this.inactiveTimeout;

            for (const workerId of workers) {
                const workerData = await this.redis.get(`${this.KEYS.WORKER}${workerId}`);
                if (workerData) {
                    const worker = JSON.parse(workerData);
                    if (worker.lastHeartbeat < cutoffTime || worker.status === 'inactive') {
                        await this.redis.srem(this.KEYS.SET.WORKERS, workerId);
                        await this.redis.del(`${this.KEYS.WORKER}${workerId}`);
                        console.log(`Cleaned up inactive worker: ${worker.hostname}`);
                    }
                }
            }
        } catch (error) {
            console.error('Error cleaning up inactive workers:', error);
        }
    }

    async initializeSocketServer(server) {
        this.io = new Server(server);

        this.io.on('connection', (socket) => {
            console.log(`[${new Date().toISOString()}] Worker connected: ${socket.id}`);

            socket.on('registerWorker', async (workerData) => {
                try {
                    const workerId = await this.getNextId('worker');
                    const worker = {
                        id: workerId,
                        hostname: workerData.hostname,
                        socketId: socket.id,
                        status: 'active',
                        lastHeartbeat: Date.now()
                    };

                    await this.redis.set(
                        `${this.KEYS.WORKER}${workerId}`,
                        JSON.stringify(worker)
                    );
                    await this.redis.sadd(this.KEYS.SET.WORKERS, workerId);

                    socket.workerId = workerId;
                    socket.emit('workerRegistered', { id: workerId });

                } catch (error) {
                    console.error('Error during worker registration:', error);
                    socket.emit('error', error.message);
                }
            });

            socket.on('workerStatus', async (statusUpdate) => {
                try {
                    const workerData = await this.redis.get(
                        `${this.KEYS.WORKER}${statusUpdate.workerId}`
                    );
                    if (workerData) {
                        const worker = JSON.parse(workerData);
                        worker.status = statusUpdate.status;
                        worker.currentLoad = statusUpdate.load;
                        worker.lastHeartbeat = Date.now();
                        await this.redis.set(
                            `${this.KEYS.WORKER}${statusUpdate.workerId}`,
                            JSON.stringify(worker)
                        );
                    }
                } catch (error) {
                    console.error('Error updating worker status:', error);
                }
            });

            socket.on('deploymentStatus', async (statusUpdate) => {
                try {
                    const deployment = await this.getDeployment(statusUpdate.deploymentId);
                    if (deployment) {
                        const workerIndex = deployment.workers.findIndex(
                            w => w.replicaId.toString() === statusUpdate.replicaId.toString()
                        );

                        if (workerIndex !== -1) {
                            deployment.workers[workerIndex].status = statusUpdate.status;
                            await this.redis.set(
                                `${this.KEYS.DEPLOYMENT}${statusUpdate.deploymentId}`,
                                JSON.stringify(deployment)
                            );
                        }

                        const replicaKey = `${this.KEYS.REPLICA}${statusUpdate.replicaId}`;
                        const replicaData = await this.redis.get(replicaKey);
                        if (replicaData) {
                            const replica = JSON.parse(replicaData);
                            replica.status = statusUpdate.status;
                            replica.metrics = statusUpdate.metrics;
                            await this.redis.set(replicaKey, JSON.stringify(replica));
                        }
                    }
                } catch (error) {
                    console.error('Error updating deployment status:', error);
                }
            });

            socket.on('disconnect', async () => {
                if (socket.workerId) {
                    try {
                        await this.redis.srem(this.KEYS.SET.WORKERS, socket.workerId);
                        await this.redis.del(`${this.KEYS.WORKER}${socket.workerId}`);
                        console.log(`Worker ${socket.workerId} disconnected and removed`);
                    } catch (error) {
                        console.error('Error removing disconnected worker:', error);
                    }
                }
            });
        });

        setInterval(() => this.cleanupInactiveWorkers(), this.cleanupInterval);
    }

    async validateGithubRepo(repoUrl) {
        try {
            const normalizedUrl = repoUrl
                .replace(/^(https:\/\/github\.com\/)+/, '')
                .replace(/\.git$/, '')
                .replace(/^https:\/\/github\.com\//, '');

            console.log(`[${new Date().toISOString()}] Validating repository:`, normalizedUrl);

            const response = await axios.get(`https://api.github.com/repos/${normalizedUrl}`);
            return response.data;
        } catch (error) {
            console.error('GitHub Repo Validation Error:', error);
            return null;
        }
    }

    async deployRepository(deploymentRequest) {
        const { githubRepo, userName, minReplicas = 1, maxReplicas = 3 } = deploymentRequest;

        const repoInfo = await this.validateGithubRepo(githubRepo);
        if (!repoInfo) {
            throw new Error('Invalid repository');
        }

        const workers = await Promise.all(
            (await this.redis.smembers(this.KEYS.SET.WORKERS))
                .map(async workerId => {
                    const workerData = await this.redis.get(`${this.KEYS.WORKER}${workerId}`);
                    return workerData ? JSON.parse(workerData) : null;
                })
        );

        const activeWorkers = workers.filter(worker =>
            worker &&
            worker.status === 'active' &&
            worker.currentLoad.cpuUsage < 80
        );

        if (activeWorkers.length < minReplicas) {
            throw new Error(`Insufficient active workers. Required: ${minReplicas}, Available: ${activeWorkers.length}`);
        }

        const deploymentId = await this.getNextId('deployment');
        const deployment = {
            id: deploymentId,
            githubRepo,
            userName,
            minReplicas,
            maxReplicas,
            status: 'deploying',
            workers: activeWorkers.slice(0, minReplicas).map((worker, index) => ({
                workerId: worker.id,
                replicaId: index + 1,
                status: 'pending'
            })),
            createdAt: Date.now()
        };

        await this.redis.set(
            `${this.KEYS.DEPLOYMENT}${deploymentId}`,
            JSON.stringify(deployment)
        );
        await this.redis.sadd(this.KEYS.SET.DEPLOYMENTS, deploymentId);

        // Create initial replicas
        for (let i = 0; i < minReplicas; i++) {
            const replicaId = await this.getNextId('replica');
            const replica = {
                id: replicaId,
                deploymentId: deploymentId,
                status: 'pending',
                replicaNumber: i + 1,
                createdAt: Date.now()
            };

            await this.redis.set(
                `${this.KEYS.REPLICA}${replicaId}`,
                JSON.stringify(replica)
            );
            await this.redis.sadd(
                `${this.KEYS.DEPLOYMENT}${deploymentId}:replicas`,
                replicaId
            );
        }

        console.log(`[2025-01-28 07:14:53] Deployment created:`, deploymentId);

        await this.distributeToWorkers(deployment, repoInfo);

        return deployment;
    }

    async distributeToWorkers(deployment, repoInfo) {
        try {
            for (const workerRef of deployment.workers) {
                const workerData = await this.redis.get(`${this.KEYS.WORKER}${workerRef.workerId}`);
                if (!workerData) {
                    console.error(`Worker not found: ${workerRef.workerId}`);
                    continue;
                }

                const worker = JSON.parse(workerData);
                const deploymentDir = `${this.deploymentPath}/${deployment.id}_${workerRef.replicaId}`;

                this.io.to(worker.socketId).emit('deployRepository', {
                    deploymentDir,
                    repoUrl: repoInfo.clone_url,
                    replicaId: workerRef.replicaId,
                    deploymentId: deployment.id,
                    deploymentTime: new Date().toISOString()
                });

                console.log(`[2025-01-28 07:14:53] Deployment task sent to worker:`, worker.hostname);
            }

            deployment.status = 'active';
            await this.redis.set(
                `${this.KEYS.DEPLOYMENT}${deployment.id}`,
                JSON.stringify(deployment)
            );
        } catch (error) {
            console.error('Error during deployment distribution:', error);
            deployment.status = 'failed';
            await this.redis.set(
                `${this.KEYS.DEPLOYMENT}${deployment.id}`,
                JSON.stringify(deployment)
            );
            throw error;
        }
    }
}

// Express application setup
const app = express();
const server = http.createServer(app);

// Initialize Redis and orchestrator
redis.on('connect', () => {
    console.log('[2025-01-28 07:14:53] Connected to Redis');
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err);
});

// Initialize orchestrator
const orchestrator = new DeploymentOrchestrator();
orchestrator.initializeSocketServer(server);

// Middleware
app.use(express.json());

// Routes
app.post('/deploy', async (req, res) => {
    try {
        const deployment = await orchestrator.deployRepository(req.body);
        res.json(deployment);
    } catch (error) {
        console.error('Deployment error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/deployments', async (req, res) => {
    try {
        const deploymentIds = await redis.smembers(orchestrator.KEYS.SET.DEPLOYMENTS);
        const deployments = await Promise.all(
            deploymentIds.map(async id => {
                const data = await redis.get(`${orchestrator.KEYS.DEPLOYMENT}${id}`);
                return data ? JSON.parse(data) : null;
            })
        );
        res.json(deployments.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/deployment/:id', async (req, res) => {
    try {
        const deployment = await redis.get(`${orchestrator.KEYS.DEPLOYMENT}${req.params.id}`);
        if (!deployment) {
            return res.status(404).json({ error: 'Deployment not found' });
        }
        res.json(JSON.parse(deployment));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/workers', async (req, res) => {
    try {
        const workerIds = await redis.smembers(orchestrator.KEYS.SET.WORKERS);
        const workers = await Promise.all(
            workerIds.map(async id => {
                const data = await redis.get(`${orchestrator.KEYS.WORKER}${id}`);
                return data ? JSON.parse(data) : null;
            })
        );
        res.json(workers.filter(Boolean).sort((a, b) => b.lastHeartbeat - a.lastHeartbeat));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/replicas/:deploymentId', async (req, res) => {
    try {
        const replicaIds = await redis.smembers(
            `${orchestrator.KEYS.DEPLOYMENT}${req.params.deploymentId}:replicas`
        );
        const replicas = await Promise.all(
            replicaIds.map(async id => {
                const data = await redis.get(`${orchestrator.KEYS.REPLICA}${id}`);
                return data ? JSON.parse(data) : null;
            })
        );
        res.json(replicas.filter(Boolean).sort((a, b) => a.replicaNumber - b.replicaNumber));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[2025-01-28 07:14:53] Main server running on port ${PORT}`);
});

// Handle process termination
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    await redis.quit();
    server.close(() => {
        console.log('Server closed. Process terminated.');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    await redis.quit();
    server.close(() => {
        console.log('Server closed. Process terminated.');
        process.exit(0);
    });
});

// Handle unhandled errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});