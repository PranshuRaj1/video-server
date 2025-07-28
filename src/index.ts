import express, { Express } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient, RedisClientType } from 'redis';
import axios from 'axios';
import FormData from 'form-data';

// @ts-ignore
import meteorRandom from 'meteor-random';

import { createWorkers, getRouter } from './mediasoup/mediasoup.config';
import {
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  RtpCapabilities,
  DtlsParameters,
  RtpParameters,
} from 'mediasoup/node/lib/types';

dotenv.config();

// --- TYPE DEFINITIONS ---

interface JoinRoomPayload {
  username: string;
  roomId: string;
  isCreator: boolean;
}

interface TransportProducePayload {
  kind: 'audio' | 'video';
  rtpParameters: RtpParameters;
  appData: any;
}

interface PeerProducerInfo {
  producerTransport: WebRtcTransport;
  producers: Map<'audio' | 'video', Producer>;
}

interface PeerConsumerInfo {
  consumerTransport: WebRtcTransport;
  consumers: Map<string, Consumer>; // Key is Producer's ID
}

interface RoomData {
  peers: string[];
}

interface CustomSocket extends Socket {
  username?: string;
  roomId?: string;
  audioId?: string; // For transcription session
}


// --- SERVER & WEBSOCKET SETUP ---

const PORT = process.env.PORT || 5001;

const websockets_CORS = {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials : true
};

const app: Express = express();
const server = http.createServer(app);
const io = new Server<any, any, any, CustomSocket>(server, { cors: websockets_CORS });


// --- REDIS CLIENT SETUP ---

const redisClient: RedisClientType = createClient({
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});


// --- IN-MEMORY STATE MANAGEMENT ---

const producerInfo = new Map<string, PeerProducerInfo>(); // Key: 'roomId:username'
const consumerInfo = new Map<string, PeerConsumerInfo>(); // Key: 'roomId:username'

// For audio transcription
const transcriptionSessionId = meteorRandom.id();
console.log('Transcription Session ID:', transcriptionSessionId);


// --- MIDDLEWARE ---

app.use(cors(websockets_CORS));
app.use(express.json());


// --- MEDIASOUP HELPER FUNCTIONS ---

const createWebRtcTransport = async (router : Router) : Promise<WebRtcTransport> => {
    const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
    });

    transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') {
            console.log(`Transport closed for ${transport.id}`);
            transport.close();
        }
    });

    return transport;
};

const cleanupPeer = async (roomId: string, username: string) => {
    const peerKey = `${roomId}:${username}`;
    console.log(`Cleaning up resources for peer: ${username} in room: ${roomId}`);

    const peerProducerInfo = producerInfo.get(peerKey);
    if (peerProducerInfo) {
        peerProducerInfo.producers.forEach(p => p.close());
        peerProducerInfo.producerTransport?.close();
        producerInfo.delete(peerKey);
    }

    const peerConsumerInfo = consumerInfo.get(peerKey);
    if (peerConsumerInfo) {
        peerConsumerInfo.consumers.forEach(c => c.close());
        peerConsumerInfo.consumerTransport?.close();
        consumerInfo.delete(peerKey);
    }
};


// --- SOCKET.IO EVENT HANDLING ---

io.on('connection', (socket: CustomSocket) => {
    console.log(` New peer connected: ${socket.id}`);
    
    // For transcription state per-socket
    let transcriptionIndex = 0;
    let isProcessingTranscription = false;

    socket.on('joinRoom', async ({ username, roomId, isCreator }: JoinRoomPayload, callback) => {
        try {
            socket.username = username;
            socket.roomId = roomId;
            socket.audioId = meteorRandom.id();
            socket.join(roomId);

            const peerKey = `${roomId}:${username}`;
            producerInfo.set(peerKey, { producerTransport: null!, producers: new Map() });
            consumerInfo.set(peerKey, { consumerTransport: null!, consumers: new Map() });

            const roomExists = await redisClient.exists(`room:${roomId}`);
            let router: Router;
            const response: { 
            rtpCapabilities?: RtpCapabilities, 
            existingProducers?: { producerId: string, username: string }[],
            error?: string 
        } = {};

            if (isCreator) {
                if (roomExists) return callback({ error: 'Room already exists.' });
                
                console.log(` Creating new room '${roomId}' for user '${username}'`);
                router = await getRouter(roomId);
                await redisClient.set(`room:${roomId}`, JSON.stringify({ peers: [username] }));
            } else {
                if (!roomExists) return callback({ error: 'Room not found.' });
                router = await getRouter(roomId);
                console.log(` Adding user '${username}' to existing room '${roomId}'`);
                const roomDataString = await redisClient.get(`room:${roomId}`);
                const roomData: RoomData = JSON.parse(roomDataString!);


                // ----------------------//
                response.existingProducers = [];
                for (const otherPeerUsername of roomData.peers) {
                const otherPeerKey = `${roomId}:${otherPeerUsername}`;
                const otherPeerProducers = producerInfo.get(otherPeerKey)?.producers;
                if (otherPeerProducers) {
                    otherPeerProducers.forEach(producer => {
                        response.existingProducers!.push({
                            producerId: producer.id,
                            username: producer.appData.username as string,
                        });
                    });
                }
            }
               
                
                roomData.peers.push(username);
                await redisClient.set(`room:${roomId}`, JSON.stringify(roomData));
            }
            
            if (router) {
                response.rtpCapabilities = router.rtpCapabilities;
            }
            callback(response);
        } catch (error) {
            console.error('Error in joinRoom:', error);
            callback({ error: (error as Error).message });
        }
    });

    socket.on('createWebRTCTransport', async (callback) => {
        if (!socket.roomId || !socket.username) return;
        try {
            const router = await getRouter(socket.roomId);
            const producerTransport = await createWebRtcTransport(router);
            const consumerTransport = await createWebRtcTransport(router);

            const peerKey = `${socket.roomId}:${socket.username}`;
            producerInfo.get(peerKey)!.producerTransport = producerTransport;
            consumerInfo.get(peerKey)!.consumerTransport = consumerTransport;

            callback({
                producer: {
                    id: producerTransport.id,
                    iceParameters: producerTransport.iceParameters,
                    iceCandidates: producerTransport.iceCandidates,
                    dtlsParameters: producerTransport.dtlsParameters,
                },
                consumer: {
                    id: consumerTransport.id,
                    iceParameters: consumerTransport.iceParameters,
                    iceCandidates: consumerTransport.iceCandidates,
                    dtlsParameters: consumerTransport.dtlsParameters,
                },
            });
        } catch (error) {
            console.error('Error creating WebRTC transport:', error);
            callback({ error: (error as Error).message });
        }
    });
  
    socket.on('transport-connect', async ({ dtlsParameters }: { dtlsParameters: DtlsParameters }) => {
        if (!socket.roomId || !socket.username) return;
        const peerKey = `${socket.roomId}:${socket.username}`;
        await producerInfo.get(peerKey)?.producerTransport.connect({ dtlsParameters });
    });
  
    socket.on('transport-recv-connect', async ({ transportId, dtlsParameters }: { transportId: string, dtlsParameters: DtlsParameters }) => {
        if (!socket.roomId || !socket.username) return;
        const peerKey = `${socket.roomId}:${socket.username}`;
        await consumerInfo.get(peerKey)?.consumerTransport.connect({ dtlsParameters });
    });

    socket.on('transport-produce', async ({ kind, rtpParameters, appData }: TransportProducePayload, callback) => {
        if (!socket.roomId || !socket.username) return;
        try {
            const peerKey = `${socket.roomId}:${socket.username}`;
            const transport = producerInfo.get(peerKey)?.producerTransport;
            if (!transport) throw new Error('Producer transport not found');

            const producer = await transport.produce({ kind, rtpParameters, appData });
            producerInfo.get(peerKey)!.producers.set(kind, producer);
      
            socket.to(socket.roomId).emit('new-producer', { username: socket.username, producerId: producer.id });

            producer.on('transportclose', () => producer.close());
            callback({ id: producer.id });
        } catch(error) {
            console.error('Error in transport-produce:', error);
            callback({ error: (error as Error).message });
        }
    });
  
    socket.on('consume', async ({ rtpCapabilities, remoteProducerId, remoteUsername }, callback) => {
        if (!socket.roomId || !socket.username) return;

        try {
            const router = await getRouter(socket.roomId);
            const peerKey = `${socket.roomId}:${socket.username}`;
            const transport = consumerInfo.get(peerKey)?.consumerTransport;

            if (!transport) return callback({ error: 'Consumer transport not found.' });

            if (router.canConsume({ producerId: remoteProducerId, rtpCapabilities })) {
                const consumer = await transport.consume({
                    producerId: remoteProducerId,
                    rtpCapabilities,
                    paused: true,
                });
                
                consumerInfo.get(peerKey)!.consumers.set(consumer.id, consumer);
                
                consumer.on('transportclose', () => console.log('Consumer transport closed'));
                consumer.on('producerclose', () => {
                    io.to(socket.id).emit('consumer-closed', { consumerId: consumer.id });
                    consumerInfo.get(peerKey)?.consumers.delete(consumer.id);
                });

                callback({
                    id: consumer.id,
                    producerId: remoteProducerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                });
            }
        } catch (error) {
            console.error('Error in consume handler:', error);
            callback({ error: (error as Error).message });
        }
    });

    socket.on('consumer-resume', async ({ consumerId }) => {
        if (!socket.roomId || !socket.username) return;
        const peerKey = `${socket.roomId}:${socket.username}`;
        const consumer = consumerInfo.get(peerKey)?.consumers.get(consumerId);
        if (consumer) {
            await consumer.resume();
        }
    });

    socket.on('hangup', async () => {
        if (!socket.roomId || !socket.username) return;
        await cleanupPeer(socket.roomId, socket.username);
        io.to(socket.roomId).emit('peer-left', { username: socket.username });
    });

    socket.on('end-meeting', async () => {
        if (!socket.roomId) return;
        const roomKey = `room:${socket.roomId}`;
        const roomDataString = await redisClient.get(roomKey);
        if (roomDataString) {
            const roomData: RoomData = JSON.parse(roomDataString);
            for (const peer of roomData.peers) {
                await cleanupPeer(socket.roomId, peer);
            }
            await redisClient.del(roomKey);
            const router = await getRouter(socket.roomId);
            router.close();
            io.to(socket.roomId).emit('meeting-ended');
            console.log(` Meeting ended and cleaned up for room: ${socket.roomId}`);
        }
    });

    socket.on('audioChunks', async (audioChunk) => {
        if (isProcessingTranscription) return;
        
        const buf = Buffer.isBuffer(audioChunk) ? audioChunk : Buffer.from(audioChunk.data);
        if (buf.length === 0) return;

        isProcessingTranscription = true;
        const formData = new FormData();
        formData.append('sessionId', transcriptionSessionId);
        formData.append('audioId', socket.audioId!);
        formData.append('data', buf, `chunk-${transcriptionIndex}`);

        try {
            await axios.post('YOUR_TRANSCRIPTION_API_ENDPOINT', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer YOUR_API_KEY`
                }
            });
            transcriptionIndex++;
        } catch (err) {
            console.error('Error sending audio chunk for transcription:', err);
        } finally {
            isProcessingTranscription = false;
        }
    });

    socket.on('disconnect', async () => {
        console.log(` Peer disconnected: ${socket.id} (${socket.username})`);
        if (!socket.roomId || !socket.username) return;
    
        await cleanupPeer(socket.roomId, socket.username);

        const roomKey = `room:${socket.roomId}`;
        const roomDataString = await redisClient.get(roomKey);
        if (roomDataString) {
            const roomData: RoomData = JSON.parse(roomDataString);
            roomData.peers = roomData.peers.filter(p => p !== socket.username);

            if (roomData.peers.length > 0) {
                await redisClient.set(roomKey, JSON.stringify(roomData));
                io.to(socket.roomId).emit('peer-left', { username: socket.username });
            } else {
                await redisClient.del(roomKey);
                console.log(`🧹 Room ${socket.roomId} is empty and has been deleted.`);
                const router = await getRouter(socket.roomId);
                router.close();
            }
        }
    });
});


// --- SERVER LIFECYCLE MANAGEMENT ---

export const startServer = async () => {
  try {
    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    await redisClient.connect();
    console.log('Connected to Redis successfully.');

    await createWorkers();
    
    server.listen(PORT, () => {
      console.log(` Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error(' Failed to start server:', error);
    process.exit(1);
  }
};

export const stopServer = async () => {
    console.log(' SIGTERM received, shutting down gracefully...');
    io.close();
    server.close();
    if (redisClient.isOpen) {
        await redisClient.quit();
    }
    console.log('Server shut down.');
};

startServer();

process.on('SIGTERM', stopServer);
process.on('SIGINT', stopServer);