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

// type definitions

// Define the structure for data passed in socket events
interface JoinRoomPayload {
  username: string;
  roomId: string; // Renamed from 'param' for clarity
  isCreator: boolean; // Renamed from 'create'
}

interface TransportProducePayload {
  kind: 'audio' | 'video';
  rtpParameters: RtpParameters;
  appData: any;
}

// Define the structure of our state management maps
interface PeerProducerInfo {
  producerTransport: WebRtcTransport;
  producers: Map<'audio' | 'video', Producer>;
}

interface PeerConsumerInfo {
  consumerTransport: WebRtcTransport;
  consumers: Map<string, Consumer>; // Key is other peer's username
}

// Structure for room data stored in Redis
interface RoomData {
  peers: string[];
}

// Extend the Socket type to hold our custom state
interface CustomSocket extends Socket {
  username?: string;
  roomId?: string;
  audioId?: string; // For transcription session
}

const PORT = process.env.PORT || 5001

const websockets_CORS = {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials : true
}

const app: Express = express()
const server = http.createServer(app)
const io = new Server(server, {cors: websockets_CORS})

// redis client setup

const redisClient: RedisClientType = createClient({
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});

// In-memory state management with strong types
const producerInfo = new Map<string, PeerProducerInfo>(); // Key: 'roomId:username'
const consumerInfo = new Map<string, PeerConsumerInfo>(); // Key: 'roomId:username'

// For audio transcription
const transcriptionSessionId = meteorRandom.id();
console.log('Transcription Session ID:', transcriptionSessionId);

// middleware
app.use(cors(websockets_CORS));
app.use(express.json());

// mediasoup functions
const createWebRtcTransport = async (router : Router) : Promise<WebRtcTransport> => {
    const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  // Datagram Transport Layer Security -> Emitted when the transport DTLS state changes.

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed') {
      console.log(`Transport closed for ${transport.id}`);
      transport.close();
    }
  });

  return transport;
}

io.on('connection', (socket: CustomSocket) => {
  console.log(` New peer connected: ${socket.id}`);

  socket.on('joinRoom', async ({ username, roomId, isCreator }: JoinRoomPayload, callback) => {
    try {
      socket.username = username;
      socket.roomId = roomId;
      socket.audioId = meteorRandom.id(); // Unique ID for this user's audio stream
      socket.join(roomId);

      const peerKey = `${roomId}:${username}`;
      producerInfo.set(peerKey, { producerTransport: null!, producers: new Map() });
      consumerInfo.set(peerKey, { consumerTransport: null!, consumers: new Map() });

      const roomExists = await redisClient.exists(`room:${roomId}`);
      let router: Router;

      if (isCreator) {
        if (roomExists) {
          return callback({ error: 'Room already exists. Please try a different ID.' });
        }
        console.log(` Creating new room '${roomId}' for user '${username}'`);
        router = await getRouter(roomId);
        const roomData: RoomData = { peers: [username] };
        await redisClient.set(`room:${roomId}`, JSON.stringify(roomData));
      } else {
        if (!roomExists) {
          return callback({ error: 'Room not found.' });
        }
        console.log(` Adding user '${username}' to existing room '${roomId}'`);
        const roomDataString = await redisClient.get(`room:${roomId}`);
        const roomData: RoomData = JSON.parse(roomDataString!);
        router = await getRouter(roomId);

        // Notify existing participants
        socket.to(roomId).emit("newParticipant", username);
        
        roomData.peers.push(username);
        await redisClient.set(`room:${roomId}`, JSON.stringify(roomData));
        
        // Send list of all participants to the new user
        callback({ peers: roomData.peers });
      }
      
      // Send router capabilities to the new user
      if (router) {
        callback({ rtpCapabilities: router.rtpCapabilities });
      }
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
  
  socket.on('transport-connect', async ({ transportId, dtlsParameters }: { transportId: string, dtlsParameters: DtlsParameters }) => {
    if (!socket.roomId || !socket.username) return;
    const peerKey = `${socket.roomId}:${socket.username}`;
    const peerProducerInfo = producerInfo.get(peerKey);
    if (peerProducerInfo?.producerTransport.id === transportId) {
        await peerProducerInfo.producerTransport.connect({ dtlsParameters });
    }
  });
  
  socket.on('transport-recv-connect', async ({ transportId, dtlsParameters }: { transportId: string, dtlsParameters: DtlsParameters }) => {
    if (!socket.roomId || !socket.username) return;
    const peerKey = `${socket.roomId}:${socket.username}`;
    const peerConsumerInfo = consumerInfo.get(peerKey);
     if (peerConsumerInfo?.consumerTransport.id === transportId) {
        await peerConsumerInfo.consumerTransport.connect({ dtlsParameters });
    }
  });

  socket.on('transport-produce', async ({ kind, rtpParameters, appData }: TransportProducePayload, callback) => {
    if (!socket.roomId || !socket.username) return;
    try {
      const peerKey = `${socket.roomId}:${socket.username}`;
      const transport = producerInfo.get(peerKey)?.producerTransport;
      if (!transport) throw new Error('Producer transport not found');

      const producer = await transport.produce({ kind, rtpParameters, appData });
      producerInfo.get(peerKey)!.producers.set(kind, producer);
      
      // Inform other clients that a new producer is available
      socket.to(socket.roomId).emit('new-producer', { username: socket.username, kind });

      producer.on('transportclose', () => producer.close());
      callback({ id: producer.id });
    } catch(error) {
        console.error('Error in transport-produce:', error);
        callback({ error: (error as Error).message });
    }
  });
  
  // Additional handlers for consume, resume, hangup, etc. would follow a similar, refactored pattern.
 

  socket.on('disconnect', async () => {
    console.log(` Peer disconnected: ${socket.id} (${socket.username})`);
    if (!socket.roomId || !socket.username) return;
    
    // Clean up user's state
    producerInfo.delete(`${socket.roomId}:${socket.username}`);
    consumerInfo.delete(`${socket.roomId}:${socket.username}`);
    
    // Remove user from Redis room
    const roomKey = `room:${socket.roomId}`;
    const roomDataString = await redisClient.get(roomKey);
    if (roomDataString) {
        const roomData: RoomData = JSON.parse(roomDataString);
        roomData.peers = roomData.peers.filter(p => p !== socket.username);

        if (roomData.peers.length > 0) {
            await redisClient.set(roomKey, JSON.stringify(roomData));
            // Notify remaining users
            io.to(socket.roomId).emit('peer-left', { username: socket.username });
        } else {
            // Last user left, delete the room
            await redisClient.del(roomKey);
            console.log(`🧹 Room ${socket.roomId} is empty and has been deleted.`);
            const router = await getRouter(socket.roomId);
            router.close();
        }
    }
  });
});

/**
 * Starts the server, connects to Redis, and initializes Mediasoup workers.
 */
export const startServer = async () => {
  try {
    // Connect to Redis
    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    await redisClient.connect();
    console.log('✅ Connected to Redis successfully.');

    // Initialize Mediasoup Workers
    await createWorkers();
    
    // Start HTTP Server
    server.listen(PORT, () => {
      console.log(`🚀 Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

/**
 * Gracefully stops the server and closes connections.
 */
export const stopServer = async () => {
    console.log(' shutting down server...');
    io.close();
    server.close();
    if (redisClient.isOpen) {
        await redisClient.quit();
    }
    console.log('Server shut down gracefully.');
};

// Start the server
startServer();

// Graceful shutdown handling
process.on('SIGTERM', stopServer);
process.on('SIGINT', stopServer);
