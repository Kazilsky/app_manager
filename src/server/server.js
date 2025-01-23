const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const axios = require('axios');
const fs = require('fs');

// Schemas
const WorkerSchema = new mongoose.Schema({
    hostname: String,
    socketId: String,
    status: {
        type: String,
        enum: ['active', 'inactive', 'overloaded', 'busy'],
        default: 'inactive'
    },
    lastHeartbeat: {
        type: Date,
        default: Date.now
    },
    currentLoad: {
        cpuUsage: Number,
        memoryUsage: Number,
        runningContainers: Number
    }
});

const DeploymentSchema = new mongoose.Schema({
    githubRepo: String,
    userName: String,
    minReplicas: Number,
    maxReplicas: Number,
    status: {
        type: String,
        enum: ['pending', 'deploying', 'active', 'failed'],
        default: 'pending'
    },
    lastScaleUp: Date,
    lastScaleDown: Date,
    workers: [{
        workerId: mongoose.Schema.Types.ObjectId,
        replicaId: Number,
        status: {
            type: String,
            enum: ['pending', 'deploying', 'active', 'failed', 'removing'],
            default: 'pending'
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const ReplicaSchema = new mongoose.Schema({
    deploymentId: mongoose.Schema.Types.ObjectId,
    status: {
        type: String,
        enum: ['pending', 'active', 'failed', 'removing'],
        default: 'pending'
    },
    replicaNumber: Number,
    metrics: {
        cpuUsage: Number,
        memoryUsage: Number
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Worker = mongoose.model('Worker', WorkerSchema);
const Deployment = mongoose.model('Deployment', DeploymentSchema);
const Replica = mongoose.model('Replica', ReplicaSchema);

class DeploymentOrchestrator {
    constructor() {
        this.io = null;
        this.deploymentPath = process.env.DEPLOYMENT_PATH || './deployments';
        this.ensureDeploymentPath();

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

    async startScalingMonitor() {
        setInterval(async () => {
            try {
                const deployments = await Deployment.find({ status: 'active' });
                for (const deployment of deployments) {
                    await this.checkAndScale(deployment);
                }
            } catch (error) {
                console.error('Error in scaling monitor:', error);
            }
        }, this.scalingSettings.checkInterval);
    }

    async checkAndScale(deployment) {
        try {
            const replicas = await Replica.find({ deploymentId: deployment._id });
            const currentReplicaCount = replicas.length;
            const activeReplicas = replicas.filter(r => r.status === 'active');

            let totalCpuLoad = 0;
            activeReplicas.forEach(replica => {
                totalCpuLoad += replica.metrics?.cpuUsage || 0;
            });

            const avgCpuLoad = activeReplicas.length > 0 ?
                totalCpuLoad / activeReplicas.length : 0;

            console.log(`[${new Date().toISOString()}] Deployment ${deployment._id} - Average CPU Load: ${avgCpuLoad}%`);

            const now = Date.now();
            if (avgCpuLoad > this.scalingSettings.cpuThreshold &&
                currentReplicaCount < deployment.maxReplicas &&
                (!deployment.lastScaleUp ||
                    (now - deployment.lastScaleUp.getTime() > this.scalingSettings.scaleUpCooldown))) {
                await this.scaleUp(deployment);
            } else if (avgCpuLoad < this.scalingSettings.cpuThreshold / 2 &&
                currentReplicaCount > deployment.minReplicas &&
                (!deployment.lastScaleDown ||
                    (now - deployment.lastScaleDown.getTime() > this.scalingSettings.scaleDownCooldown))) {
                await this.scaleDown(deployment);
            }
        } catch (error) {
            console.error(`Error checking scaling for deployment ${deployment._id}:`, error);
        }
    }

    async scaleUp(deployment) {
        try {
            console.log(`[${new Date().toISOString()}] Scaling up deployment ${deployment._id}`);

            const worker = await this.findAvailableWorker();
            if (!worker) {
                throw new Error('No available workers found');
            }

            const newReplica = new Replica({
                deploymentId: deployment._id,
                status: 'pending',
                replicaNumber: deployment.workers.length + 1
            });
            await newReplica.save();

            deployment.lastScaleUp = new Date();
            deployment.workers.push({
                workerId: worker._id,
                replicaId: newReplica.replicaNumber,
                status: 'pending'
            });
            await deployment.save();

            this.io.to(worker.socketId).emit('deploymentTask', {
                deploymentId: deployment._id,
                replicaId: newReplica.replicaNumber,
                githubRepo: deployment.githubRepo,
                deploymentTime: new Date().toISOString()
            });

        } catch (error) {
            console.error(`Error scaling up deployment ${deployment._id}:`, error);
        }
    }

    async scaleDown(deployment) {
        try {
            console.log(`[${new Date().toISOString()}] Scaling down deployment ${deployment._id}`);

            const lastWorker = deployment.workers[deployment.workers.length - 1];
            if (!lastWorker) return;

            const worker = await Worker.findById(lastWorker.workerId);
            if (!worker) return;

            this.io.to(worker.socketId).emit('removeReplica', {
                deploymentId: deployment._id,
                replicaId: lastWorker.replicaId
            });

            deployment.lastScaleDown = new Date();
            deployment.workers = deployment.workers.slice(0, -1);
            await deployment.save();

            await Replica.findOneAndUpdate(
                { deploymentId: deployment._id, replicaNumber: lastWorker.replicaId },
                { status: 'removing' }
            );

        } catch (error) {
            console.error(`Error scaling down deployment ${deployment._id}:`, error);
        }
    }

    async findAvailableWorker() {
        return await Worker.findOne({
            status: 'active',
            'currentLoad.cpuUsage': { $lt: 80 }
        }).sort({ 'currentLoad.cpuUsage': 1 });
    }

    async cleanupInactiveWorkers() {
        try {
            const cutoffTime = new Date(Date.now() - this.inactiveTimeout);
            const inactiveWorkers = await Worker.find({
                $or: [
                    { lastHeartbeat: { $lt: cutoffTime } },
                    { status: 'inactive' }
                ]
            });

            if (inactiveWorkers.length > 0) {
                console.log(`[${new Date().toISOString()}] Found inactive workers:`,
                    inactiveWorkers.map(w => w.hostname));

                await Worker.deleteMany({
                    _id: { $in: inactiveWorkers.map(w => w._id) }
                });

                console.log(`Cleaned up ${inactiveWorkers.length} inactive workers`);
            }
        } catch (error) {
            console.error('Error cleaning up inactive workers:', error);
        }
    }

    async initializeSocketServer(server) {
        this.io = new Server(server);

        this.io.on('connection', (socket) => {
            console.log(`[${new Date().toISOString()}] Worker connected: ${socket.id}`);

            let heartbeatTimeout;
            const resetHeartbeatTimeout = () => {
                if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
                heartbeatTimeout = setTimeout(async () => {
                    if (socket.workerId) {
                        try {
                            await Worker.findByIdAndUpdate(socket.workerId,
                                { status: 'inactive', socketId: null });
                            console.log(`Worker ${socket.workerId} marked inactive due to missing heartbeat`);
                        } catch (error) {
                            console.error('Error updating worker status:', error);
                        }
                    }
                }, this.inactiveTimeout);
            };

            socket.on('registerWorker', async (workerData) => {
                try {
                    await Worker.deleteMany({ hostname: workerData.hostname });

                    const worker = new Worker({
                        hostname: workerData.hostname,
                        socketId: socket.id,
                        status: 'active',
                        lastHeartbeat: new Date()
                    });

                    await worker.save();
                    socket.workerId = worker._id;
                    socket.emit('workerRegistered', { id: worker._id });

                    console.log(`[${new Date().toISOString()}] Worker registered:`, worker.hostname);
                    resetHeartbeatTimeout();
                } catch (error) {
                    console.error('Error during worker registration:', error);
                    socket.emit('error', error.message);
                }
            });

            socket.on('workerStatus', async (statusUpdate) => {
                try {
                    const worker = await Worker.findById(statusUpdate.workerId);
                    if (worker) {
                        worker.status = statusUpdate.status;
                        worker.currentLoad = statusUpdate.load;
                        worker.lastHeartbeat = new Date();
                        await worker.save();
                        resetHeartbeatTimeout();
                    }
                } catch (error) {
                    console.error('Error updating worker status:', error);
                }
            });

            socket.on('deploymentStatus', async (statusUpdate) => {
                try {
                    const deployment = await Deployment.findById(statusUpdate.deploymentId);
                    if (deployment) {
                        const workerIndex = deployment.workers.findIndex(
                            w => w.replicaId.toString() === statusUpdate.replicaId.toString()
                        );

                        if (workerIndex !== -1) {
                            deployment.workers[workerIndex].status = statusUpdate.status;
                            await deployment.save();
                        }

                        await Replica.findOneAndUpdate(
                            {
                                deploymentId: statusUpdate.deploymentId,
                                replicaNumber: statusUpdate.replicaId
                            },
                            {
                                status: statusUpdate.status,
                                metrics: statusUpdate.metrics
                            }
                        );
                    }
                } catch (error) {
                    console.error('Error updating deployment status:', error);
                }
            });

            socket.on('disconnect', async () => {
                if (socket.workerId) {
                    try {
                        await Worker.findByIdAndDelete(socket.workerId);
                        console.log(`[${new Date().toISOString()}] Worker ${socket.workerId} disconnected and removed`);
                    } catch (error) {
                        console.error('Error removing disconnected worker:', error);
                    }
                }
                if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
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

        const workers = await Worker.find({
            status: 'active',
            'currentLoad.cpuUsage': { $lt: 80 }
        }).sort({ 'currentLoad.cpuUsage': 1 }).limit(maxReplicas);

        if (workers.length < minReplicas) {
            throw new Error(`Insufficient active workers. Required: ${minReplicas}, Available: ${workers.length}`);
        }

        const deployment = new Deployment({
            githubRepo,
            userName,
            minReplicas,
            maxReplicas,
            status: 'deploying',
            workers: workers.slice(0, minReplicas).map((worker, index) => ({
                workerId: worker._id,
                replicaId: index + 1,
                status: 'pending'
            }))
        });

        await deployment.save();

        // Создаем начальные реплики
        for (let i = 0; i < minReplicas; i++) {
            await new Replica({
                deploymentId: deployment._id,
                status: 'pending',
                replicaNumber: i + 1
            }).save();
        }

        console.log(`[${new Date().toISOString()}] Deployment created:`, deployment._id);

        await this.distributeToWorkers(deployment, repoInfo);

        return deployment;
    }

    async distributeToWorkers(deployment, repoInfo) {
        try {
            for (const workerRef of deployment.workers) {
                const worker = await Worker.findById(workerRef.workerId);
                if (!worker) {
                    console.error(`Worker not found: ${workerRef.workerId}`);
                    continue;
                }

                const deploymentDir = `${this.deploymentPath}/${deployment._id}_${workerRef.replicaId}`;

                this.io.to(worker.socketId).emit('deployRepository', {
                    deploymentDir,
                    repoUrl: repoInfo.clone_url,
                    replicaId: workerRef.replicaId,
                    deploymentId: deployment._id,
                    deploymentTime: new Date().toISOString()
                });

                console.log(`[${new Date().toISOString()}] Deployment task sent to worker:`, worker.hostname);
            }

            deployment.status = 'active';
            await deployment.save();
        } catch (error) {
            console.error('Error during deployment distribution:', error);
            deployment.status = 'failed';
            await deployment.save();
            throw error;
        }
    }
}

// Express application setup
const app = express();
const server = http.createServer(app);

// MongoDB connection
mongoose.connect('mongodb://localhost:27017/deployment_system', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('[2025-01-23 19:17:21] Connected to MongoDB');
}).catch(err => {
    console.error('MongoDB connection error:', err);
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
        const deployments = await Deployment.find()
            .sort({ createdAt: -1 })
            .limit(10);
        res.json(deployments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/deployment/:id', async (req, res) => {
    try {
        const deployment = await Deployment.findById(req.params.id);
        if (!deployment) {
            return res.status(404).json({ error: 'Deployment not found' });
        }
        res.json(deployment);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/workers', async (req, res) => {
    try {
        const workers = await Worker.find()
            .sort({ lastHeartbeat: -1 });
        res.json(workers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/replicas/:deploymentId', async (req, res) => {
    try {
        const replicas = await Replica.find({ deploymentId: req.params.deploymentId })
            .sort({ replicaNumber: 1 });
        res.json(replicas);
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
    console.log(`[2025-01-23 19:17:21] Main server running on port ${PORT}`);
});

// Handle process termination
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    await mongoose.connection.close();
    server.close(() => {
        console.log('Server closed. Process terminated.');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    await mongoose.connection.close();
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